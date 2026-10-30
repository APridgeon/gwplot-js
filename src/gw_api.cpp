// gw_api.cpp: gwplot-js's JavaScript API (embind) for gw. The Makefile links it with gw's
// own sources, built as for gw's browser page (deps/wasm/flags.mk), in place of main.cpp's
// windowed UI.
//
// Gw is a headless gw (Manager::GwPlot): it draws into memory, never into a window, as
// gwplot's Python Gw does (gwplot/gwplot/interface.pyx in https://github.com/kcleal/gwplot).
// Its methods are ports of that Cython under camelCase names, with the same behaviour, so
// the two draw the same picture and report the same state from the same gw.
//
// gw reads its files through Emscripten's file system; fs_bridge.mjs puts files there that
// are read from a web server on demand. Calls must come one at a time, from one thread:
// in a browser, a Web Worker (fs_bridge's reads are synchronous).

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cstdlib>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <GLFW/glfw3.h>

#include "htslib/kstring.h"
#include "htslib/sam.h"
#include "imgui.h"
#include "ini.h"
#include "plot_manager.h"
#include "themes.h"
#include "utils.h"

#include "include/core/SkImageInfo.h"

using emscripten::val;

namespace {

std::vector<std::string> splitTabs(const std::string& text) {
    std::vector<std::string> fields;
    std::stringstream stream(text);
    std::string field;
    while (std::getline(stream, field, '\t')) fields.push_back(field);
    return fields;
}

// Python's float repr, which gwplot puts into the commands it builds; any form gw parses
// to the same value would do, but this keeps the command text the same too.
std::string pyFloat(double value) {
    std::string text;
    // the shortest form that reads back as the same value, as Python prints it
    for (int digits = 1; digits <= 17; ++digits) {
        std::ostringstream shorter;
        shorter.precision(digits);
        shorter << value;
        if (std::stod(shorter.str()) == value) {
            text = shorter.str();
            break;
        }
    }
    if (text.find_first_of(".eE") == std::string::npos) text += ".0";
    return text;
}

}  // namespace

class Gw {
public:
    // gw's own default settings, as gwplot's Gw(reference) without an ini: gw writes its
    // default .gw.ini to the file system's /tmp and reads it back.
    Gw(const std::string& reference, int width, int height) : Gw(reference, width, height, "") {}

    // ``iniPath``: a gw .gw.ini already in the file system ("" for gw's defaults).
    Gw(const std::string& reference, int width, int height, const std::string& iniPath) {
        Themes::IniOptions opts;
        if (iniPath.empty()) {
            if (!opts.readIni()) {
                std::string theme = "dark";  // no writable /tmp: gw's built-in defaults
                opts.setTheme(theme);
            }
        } else {
            opts.ini_path = iniPath;
            mINI::INIFile file(opts.ini_path);
            if (!file.read(opts.myIni)) {
                throw std::runtime_error("could not read gw ini file: " + iniPath);
            }
            opts.getOptionsFromIni();
        }
        opts.threads = 1;  // the WebAssembly build is single-threaded
        opts.theme.setAlphas();

        // gw calls into ImGui from some commands (e.g. "theme"), so a context must exist;
        // like gwplot's, it only holds state: there is no window or GL context.
        imgui = ImGui::CreateContext();

        std::vector<std::string> bams, tracks;
        std::vector<Utils::Region> regions;
        plot = std::make_unique<Manager::GwPlot>(reference, bams, opts, regions, tracks);
        plot->drawToBackWindow = true;
        plot->redraw = true;
        plot->terminalOutput = false;
        plot->opts.theme.setAlphas();
        setCanvasSize(width, height);
    }

    ~Gw() {
        plot.reset();
        ImGui::DestroyContext(imgui);
    }

    // --- Files and regions ------------------------------------------------------------

    void addBam(const std::string& path) {
        std::string p = path;
        plot->addBam(p);
    }

    void addTrack(const std::string& path) {
        std::string p = path;
        plot->addTrack(p, false, true, true);
    }

    void addRegion(const std::string& chrom, int start, int end) {
        plot->regions.push_back(Utils::Region());
        plot->regions.back().chrom = chrom;
        plot->regions.back().start = start;
        plot->regions.back().end = end;
        plot->fetchRefSeq(plot->regions.back());
        plot->regionSelection = static_cast<int>(plot->regions.size()) - 1;
        plot->resetCollectionRegionPtrs();
    }

    void clearRegions() {
        while (!plot->regions.empty()) plot->removeRegion(0);
        plot->clearImageCacheQueue();
    }

    // --- Commands and input -----------------------------------------------------------

    // A gw command line, as typed into gw's command box. "expand-tracks on|off" sets the
    // option rather than toggling it.
    void applyCommand(const std::string& command) {
        std::string text = command;
        std::istringstream words(command);
        std::vector<std::string> parts;
        for (std::string word; words >> word;) parts.push_back(word);
        if (parts.size() == 2 && parts[0] == "expand-tracks") {
            std::string arg = parts[1];
            std::transform(arg.begin(), arg.end(), arg.begin(), ::tolower);
            bool want = arg == "1" || arg == "on" || arg == "true" || arg == "yes";
            if (plot->opts.expand_tracks == want) return;
            text = "expand-tracks";  // the native command toggles
        }
        ImGui::SetCurrentContext(imgui);
        plot->inputText = text;
        plot->commandProcessed();
    }

    void keyPress(int key, int scancode, int action, int mods) {
        ImGui::SetCurrentContext(imgui);
        plot->keyPress(key, scancode, action, mods);
    }

    void mouseEvent(double x, double y, int button, int action) { mouseEvent(x, y, button, action, 0); }

    // A button press or release at (x, y), in frame-buffer pixels; ``mods`` are GLFW
    // modifier bits (MOD_SHIFT, ...).
    void mouseEvent(double x, double y, int button, int action, int mods) {
        ImGui::SetCurrentContext(imgui);
        plot->xPos_fb = x;
        plot->yPos_fb = y;
        plot->mouseButton(button, action, mods);
    }

    // The pointer moved to (x, y): with the left button down (a mouseEvent press), a drag
    // that pans, or moves the scale bar or a track divider, as in gw's window.
    void mouseMove(double x, double y) {
        ImGui::SetCurrentContext(imgui);
        plot->mousePos(x, y);
    }

    // A wheel or trackpad scroll, in steps: gw zooms (dy) or pans (dx), as in its window.
    void scroll(double dx, double dy) {
        ImGui::SetCurrentContext(imgui);
        plot->scrollGesture(dx, dy);
    }

    // --- Markers ----------------------------------------------------------------------

    void addMarker(const std::string& chrom, int pos) {
        applyCommand("marker " + chrom + " " + std::to_string(pos) + " " + std::to_string(pos + 1));
    }

    void removeMarker(const std::string& chrom, int pos) {
        applyCommand("remove-marker " + chrom + " " + std::to_string(pos));
    }

    void clearMarkers() { applyCommand("clear-markers"); }

    // --- Selection --------------------------------------------------------------------

    std::string selectedAlign() const { return plot->selectedAlign; }
    std::string selectedIntron() const { return plot->selectedIntron; }
    std::string selectedFeature() const { return plot->selectedFeature; }
    void clearSelectedAlign() { plot->selectedAlign.clear(); }
    void clearSelectedIntron() { plot->selectedIntron.clear(); }
    void clearSelectedFeature() { plot->selectedFeature.clear(); }

    // Jump to the selected read's mate and select it (gwplot's select_mate): runs gw's
    // ``mate`` command, then finds the other end of the pair in the pane it moved to.
    // Returns its SAM record, or "" if no read with a mapped mate is selected or the mate
    // isn't found.
    std::string selectMate() {
        std::vector<std::string> fields = splitTabs(plot->selectedAlign);
        if (fields.size() < 11 || fields[6] == "*") return "";
        const std::string qname = fields[0];
        int flag;
        int64_t matePos;
        try {
            size_t used;
            flag = std::stoi(fields[1], &used);
            if (used != fields[1].size()) return "";
            matePos = std::stoll(fields[7], &used) - 1;  // PNEXT is 1-based
            if (used != fields[7].size()) return "";
        } catch (const std::exception&) {
            return "";
        }
        // 0x40/0x80: first/last in pair; match the other end (any end if unset)
        const uint16_t otherEnd = flag & 0x40 ? 0x80 : flag & 0x80 ? 0x40 : 0;
        applyCommand("mate");  // loads the mate's region and highlights the pair
        const int pane = plot->regionSelection;
        for (auto& collection : plot->collections) {
            if (collection.regionIdx != pane) continue;
            for (auto& align : collection.readQueue) {
                bam1_t* b = align.delegate;
                if (b == nullptr || b->core.pos != matePos || b->core.flag & 0x900) continue;  // secondary, supplementary
                if (otherEnd && !(b->core.flag & otherEnd)) continue;
                if (qname != bam_get_qname(b)) continue;
                kstring_t ks = KS_INITIALIZE;
                if (sam_format1(plot->headers[collection.bamIdx], b, &ks) < 0) {
                    free(ks.s);
                    return "";
                }
                std::string sam(ks.s, ks.l);
                free(ks.s);
                plot->selectedAlign = sam;
                return sam;
            }
        }
        return "";
    }

    // --- Layout -----------------------------------------------------------------------

    void setCanvasSize(int width, int height) {
        plot->opts.dimensions.x = width;
        plot->opts.dimensions.y = height;
        plot->setImageSize(width, height);
        if (plot->makeRasterSurface() == 0) {
            throw std::runtime_error("could not create a " + std::to_string(width) + "x" +
                                     std::to_string(height) + " raster surface");
        }
    }

    int width() const { return plot->fb_width; }
    int height() const { return plot->fb_height; }

    // Whether the next draw re-reads the alignments / whether the picture changed.
    bool clearBuffer() const { return !plot->processed; }
    bool redraw() const { return plot->redraw; }

    int vscroll() const { return plot->collections.empty() ? 0 : plot->collections[0].vScroll; }
    void setVscroll(int value) { plot->setVScroll(value); }

    // Peak read depth over the alignments: the read layout stops at ylim, so this sizes
    // the scrollbar.
    int pileupDepth() const {
        int depth = 0;
        for (const auto& collection : plot->collections) depth = std::max(depth, collection.maxCoverage);
        return depth;
    }

    // The loaded annotation tracks, in draw order (gwplot's get_tracks).
    val tracks() const {
        val list = val::array();
        for (size_t i = 0; i < plot->tracks.size(); ++i) {
            const auto& track = plot->tracks[i];
            val item = val::object();
            item.set("index", static_cast<int>(i));
            item.set("name", track.name);
            item.set("kind", static_cast<int>(track.kind));
            item.set("bam_index", track.bamIndex);
            item.set("height_fraction", track.height_fraction);
            list.call<void>("push", item);
        }
        return list;
    }

    // The scale bar's band and the panes (gwplot's get_viewport), in frame-buffer pixels.
    val viewport() const {
        // with the Cython's float and double steps, so the numbers match it exactly
        float top = 0, bottom = 0;
        if (plot->opts.scale_bar) {
            float yh = std::max(plot->fb_height * 0.0175, 10.0 * plot->monitorScale);
            top = plot->topMenuSpace;
            float above = plot->topMenuSpace + plot->fonts.overlayHeight + plot->gap;
            bottom = above + yh * 0.70;
        }
        val regions = val::array();
        for (size_t i = 0; i < plot->regions.size(); ++i) {
            val region = val::object();
            region.set("index", static_cast<int>(i));
            region.set("chrom", plot->regions[i].chrom);
            region.set("start", plot->regions[i].start);
            region.set("end", plot->regions[i].end);
            regions.call<void>("push", region);
        }
        val viewport = val::object();
        viewport.set("scale_bar_enabled", static_cast<bool>(plot->opts.scale_bar));
        viewport.set("scale_bar_top", static_cast<double>(top));
        viewport.set("scale_bar_bottom", static_cast<double>(bottom));
        viewport.set("gap", static_cast<double>(plot->gap));
        viewport.set("regions", regions);
        return viewport;
    }

    // --- Display settings -------------------------------------------------------------

    std::string theme() const { return plot->opts.theme.name; }
    void setTheme(const std::string& name) {
        if (name != "slate" && name != "dark" && name != "igv") {
            throw std::invalid_argument("Theme must be one of slate, dark, igv");
        }
        std::string theme = name;
        plot->opts.setTheme(theme);
        plot->opts.theme.setAlphas();
    }

    int ylim() const { return plot->opts.ylim; }
    void setYlim(int ylim) {
        plot->opts.ylim = ylim;
        plot->samMaxY = ylim;
    }

    int softClipThreshold() const { return plot->opts.soft_clip_threshold; }
    void setSoftClipThreshold(int value) { plot->opts.soft_clip_threshold = value; }
    int smallIndelThreshold() const { return plot->opts.small_indel_threshold; }
    void setSmallIndelThreshold(int value) { plot->opts.small_indel_threshold = value; }
    int snpThreshold() const { return plot->opts.snp_threshold; }
    void setSnpThreshold(int value) { plot->opts.snp_threshold = value; }
    int edgeHighlights() const { return plot->opts.edge_highlights; }
    void setEdgeHighlights(int value) { plot->opts.edge_highlights = value; }
    int maxCoverage() const { return plot->opts.max_coverage; }
    void setMaxCoverage(int value) { plot->opts.max_coverage = value; }
    bool log2Cov() const { return plot->opts.log2_cov; }
    void setLog2Cov(bool value) { plot->opts.log2_cov = value; }
    bool expandTracks() const { return plot->opts.expand_tracks; }
    void setExpandTracks(bool value) { plot->opts.expand_tracks = value; }
    bool mods() const { return plot->opts.parse_mods; }
    bool drawLine() const { return plot->drawLine; }
    int minJunctionReads() const { return plot->opts.min_junction_reads; }
    double tabTrackHeight() const { return plot->opts.tab_track_height; }

    void setTrackHeight(int index, double height) {
        if (index < 0 || index >= static_cast<int>(plot->tracks.size())) {
            throw std::out_of_range("Track index " + std::to_string(index) + " out of range");
        }
        applyCommand("track-height " + std::to_string(index) + " " + pyFloat(height));
    }

    bool translation() const { return plot->opts.show_translation; }
    int translationFrame() const { return plot->opts.translation_frame + 1; }
    std::string translationStrand() const { return plot->opts.translation_strand ? "+" : "-"; }
    void setTranslation(bool enabled) { applyCommand(enabled ? "translate on" : "translate off"); }
    void setTranslationFrame(int frame) {
        if (frame < 1 || frame > 3) throw std::invalid_argument("Frame must be 1, 2 or 3");
        applyCommand("translate frame " + std::to_string(frame));
    }
    void setTranslationStrand(const std::string& strand) {
        std::string s = strand;
        std::transform(s.begin(), s.end(), s.begin(), ::tolower);
        static const std::vector<std::string> allowed{"+", "forward", "f", "plus", "-", "reverse", "r", "minus"};
        if (std::find(allowed.begin(), allowed.end(), s) == allowed.end()) {
            throw std::invalid_argument("Strand must be one of + forward f plus - reverse r minus");
        }
        applyCommand("translate strand " + s);
    }

    // --- Drawing ----------------------------------------------------------------------

    // Draw the current view, then copy it out as unpremultiplied RGBA (what an ImageData
    // holds), whatever pixel layout gw's surface uses.
    void draw() {
        ImGui::SetCurrentContext(imgui);
        plot->syncImageCacheQueue();
        plot->drawScreen(false);
        SkImageInfo info = SkImageInfo::Make(plot->fb_width, plot->fb_height, kRGBA_8888_SkColorType,
                                             kUnpremul_SkAlphaType);
        rgba.resize(info.computeMinByteSize());
        if (!plot->rasterSurface->readPixels(info, rgba.data(), info.minRowBytes(), 0, 0)) {
            throw std::runtime_error("could not read the drawn frame");
        }
    }

    // The last drawn frame: width * height * 4 bytes. A view of wasm memory, valid only
    // until the next call into the module, so copy it out straight away.
    val pixels() const { return val(emscripten::typed_memory_view(rgba.size(), rgba.data())); }

    // The last drawn frame as a PNG (gw's own encoder, as the server's frames use).
    val encodePng(int compression) {
        auto [data, size] = plot->encodeToPng(compression);
        if (data == nullptr) throw std::runtime_error("could not encode the frame as PNG");
        return val(emscripten::typed_memory_view(size, data));
    }

    std::string flushLog() { return plot->flushLog(); }

private:
    ImGuiContext* imgui = nullptr;
    std::unique_ptr<Manager::GwPlot> plot;
    std::vector<uint8_t> rgba;
};

// What a C++ exception says, for JavaScript: with -fexceptions it arrives as a pointer.
std::string exceptionMessage(intptr_t pointer) { return reinterpret_cast<std::exception*>(pointer)->what(); }

EMSCRIPTEN_BINDINGS(gwplot) {
    emscripten::class_<Gw>("Gw")
        .constructor<const std::string&, int, int>()
        .constructor<const std::string&, int, int, const std::string&>()
        .function("addBam", &Gw::addBam)
        .function("addTrack", &Gw::addTrack)
        .function("addRegion", &Gw::addRegion)
        .function("clearRegions", &Gw::clearRegions)
        .function("applyCommand", &Gw::applyCommand)
        .function("keyPress", &Gw::keyPress)
        .function("mouseEvent", emscripten::select_overload<void(double, double, int, int)>(&Gw::mouseEvent))
        .function("mouseEvent", emscripten::select_overload<void(double, double, int, int, int)>(&Gw::mouseEvent))
        .function("mouseMove", &Gw::mouseMove)
        .function("scroll", &Gw::scroll)
        .function("addMarker", &Gw::addMarker)
        .function("removeMarker", &Gw::removeMarker)
        .function("clearMarkers", &Gw::clearMarkers)
        .function("selectedAlign", &Gw::selectedAlign)
        .function("selectedIntron", &Gw::selectedIntron)
        .function("selectedFeature", &Gw::selectedFeature)
        .function("clearSelectedAlign", &Gw::clearSelectedAlign)
        .function("clearSelectedIntron", &Gw::clearSelectedIntron)
        .function("clearSelectedFeature", &Gw::clearSelectedFeature)
        .function("selectMate", &Gw::selectMate)
        .function("setCanvasSize", &Gw::setCanvasSize)
        .function("width", &Gw::width)
        .function("height", &Gw::height)
        .function("clearBuffer", &Gw::clearBuffer)
        .function("redraw", &Gw::redraw)
        .function("vscroll", &Gw::vscroll)
        .function("setVscroll", &Gw::setVscroll)
        .function("pileupDepth", &Gw::pileupDepth)
        .function("tracks", &Gw::tracks)
        .function("viewport", &Gw::viewport)
        .function("theme", &Gw::theme)
        .function("setTheme", &Gw::setTheme)
        .function("ylim", &Gw::ylim)
        .function("setYlim", &Gw::setYlim)
        .function("softClipThreshold", &Gw::softClipThreshold)
        .function("setSoftClipThreshold", &Gw::setSoftClipThreshold)
        .function("smallIndelThreshold", &Gw::smallIndelThreshold)
        .function("setSmallIndelThreshold", &Gw::setSmallIndelThreshold)
        .function("snpThreshold", &Gw::snpThreshold)
        .function("setSnpThreshold", &Gw::setSnpThreshold)
        .function("edgeHighlights", &Gw::edgeHighlights)
        .function("setEdgeHighlights", &Gw::setEdgeHighlights)
        .function("maxCoverage", &Gw::maxCoverage)
        .function("setMaxCoverage", &Gw::setMaxCoverage)
        .function("log2Cov", &Gw::log2Cov)
        .function("setLog2Cov", &Gw::setLog2Cov)
        .function("expandTracks", &Gw::expandTracks)
        .function("setExpandTracks", &Gw::setExpandTracks)
        .function("mods", &Gw::mods)
        .function("drawLine", &Gw::drawLine)
        .function("minJunctionReads", &Gw::minJunctionReads)
        .function("tabTrackHeight", &Gw::tabTrackHeight)
        .function("setTrackHeight", &Gw::setTrackHeight)
        .function("translation", &Gw::translation)
        .function("translationFrame", &Gw::translationFrame)
        .function("translationStrand", &Gw::translationStrand)
        .function("setTranslation", &Gw::setTranslation)
        .function("setTranslationFrame", &Gw::setTranslationFrame)
        .function("setTranslationStrand", &Gw::setTranslationStrand)
        .function("draw", &Gw::draw)
        .function("pixels", &Gw::pixels)
        .function("encodePng", &Gw::encodePng)
        .function("flushLog", &Gw::flushLog);
    emscripten::function("exceptionMessage", &exceptionMessage);

    // The GLFW constants gw's input methods take (gwplot's GLFW), and gw's intron track kind
    emscripten::constant("KEY_RIGHT", GLFW_KEY_RIGHT);
    emscripten::constant("KEY_LEFT", GLFW_KEY_LEFT);
    emscripten::constant("KEY_UP", GLFW_KEY_UP);
    emscripten::constant("KEY_DOWN", GLFW_KEY_DOWN);
    emscripten::constant("KEY_PAGE_UP", GLFW_KEY_PAGE_UP);
    emscripten::constant("KEY_PAGE_DOWN", GLFW_KEY_PAGE_DOWN);
    emscripten::constant("PRESS", GLFW_PRESS);
    emscripten::constant("RELEASE", GLFW_RELEASE);
    emscripten::constant("MOUSE_BUTTON_LEFT", GLFW_MOUSE_BUTTON_LEFT);
    emscripten::constant("MOUSE_BUTTON_RIGHT", GLFW_MOUSE_BUTTON_RIGHT);
    emscripten::constant("MOUSE_BUTTON_MIDDLE", GLFW_MOUSE_BUTTON_MIDDLE);
    emscripten::constant("MOD_SHIFT", GLFW_MOD_SHIFT);
    emscripten::constant("MOD_CONTROL", GLFW_MOD_CONTROL);
    emscripten::constant("MOD_ALT", GLFW_MOD_ALT);
    emscripten::constant("MOD_SUPER", GLFW_MOD_SUPER);
    emscripten::constant("INTRON_TRACK_KIND", static_cast<int>(HGW::FType::INTRON));
}
