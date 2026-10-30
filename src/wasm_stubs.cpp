// wasm_stubs.cpp: gwplot-js's copy of gw's src/wasm_stubs.cpp, linked in its place.
//
// gw's file also streams a reference given by URL (resolve_genome_path), through its
// page's online-files.mjs and Asyncify, neither of which this module has: a host puts
// remote files in the file system itself (fs_bridge's mountUrl) and passes their paths.
// The GLFW stubs below are gw's, unchanged; if gw's file gains other symbols, the link
// fails on them, and they belong here too.

#include <GLFW/glfw3.h>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <iostream>
#include <string>

#include "utils.h"

extern "C" {

// The browser drives its own event loop via requestAnimationFrame;
// waking it with an empty platform event is a no-op.
__attribute__((weak)) void glfwPostEmptyEvent(void) {}

// No windowing system to shut down in the browser.
__attribute__((weak)) void glfwTerminate(void) {}

// No primary monitor in the browser; return NULL.
__attribute__((weak)) GLFWmonitor* glfwGetPrimaryMonitor(void) { return nullptr; }

// Return a plausible 1920x1080 work area so callers can compute step sizes.
__attribute__((weak)) void glfwGetMonitorWorkarea(GLFWmonitor* /*mon*/,
                                                   int* xpos, int* ypos,
                                                   int* width, int* height) {
    if (xpos)   *xpos   = 0;
    if (ypos)   *ypos   = 0;
    if (width)  *width  = 1920;
    if (height) *height = 1080;
}

// Window position is not meaningful in the browser.
__attribute__((weak)) void glfwGetWindowPos(GLFWwindow* /*win*/,
                                             int* xpos, int* ypos) {
    if (xpos) *xpos = 0;
    if (ypos) *ypos = 0;
}
__attribute__((weak)) void glfwSetWindowPos(GLFWwindow* /*win*/, int /*x*/, int /*y*/) {}

// Map window/framebuffer queries to the Emscripten canvas size.
__attribute__((weak)) void glfwGetWindowSize(GLFWwindow* /*win*/,
                                              int* width, int* height) {
    int w = 0, h = 0;
    emscripten_get_canvas_element_size("#canvas", &w, &h);
    if (width)  *width  = w;
    if (height) *height = h;
}
__attribute__((weak)) void glfwSetWindowSize(GLFWwindow* /*win*/, int w, int h) {
    emscripten_set_canvas_element_size("#canvas", w, h);
}
__attribute__((weak)) void glfwGetFramebufferSize(GLFWwindow* /*win*/,
                                                   int* width, int* height) {
    int w = 0, h = 0;
    emscripten_get_canvas_element_size("#canvas", &w, &h);
    if (width)  *width  = w;
    if (height) *height = h;
}

}  // extern "C"

std::string resolve_genome_path(const std::string& path) {
    if (path.rfind("http://", 0) != 0 && path.rfind("https://", 0) != 0) return path;
    std::cerr << "Error: gwplot-js can't open a reference by URL (" << path
              << "); put it in the file system first (fs_bridge's mountUrl) and pass its path\n";
    return "";
}
