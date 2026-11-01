"use strict";

const SRC_PATH = "/data/local/tmp/libTool.so";

console.log("[+] Script started");

// === ЧТЕНИЕ ИМЕНИ ПАКЕТА (с обработкой \0) ===
function getPackageName() {
    try {
        const libc = Process.getModuleByName("libc.so");
        const openF  = new NativeFunction(libc.getExportByName("open"),  "int", ["pointer", "int", "int"]);
        const readF  = new NativeFunction(libc.getExportByName("read"),  "int", ["int", "pointer", "int"]);
        const closeF = new NativeFunction(libc.getExportByName("close"), "int", ["int"]);

        const fd = openF(Memory.allocUtf8String("/proc/self/cmdline"), 0, 0);
        if (fd < 0) return null;

        const buf = Memory.alloc(256);
        const n = readF(fd, buf, 255);
        closeF(fd);
        if (n <= 0) return null;

        // Ищем первый \0 вручную
        let len = 0;
        while (len < n && buf.add(len).readU8() !== 0) len++;
        if (len === 0) return null;

        return buf.readUtf8String(len);
    } catch (e) {
        console.log("[PKG] ERR reading cmdline: " + e.message);
        return null;
    }
}

const packageName = getPackageName();
if (!packageName) {
    console.log("[PKG] FATAL: cannot determine package name");
    console.log("[+] Script finished");
} else {
    console.log("[PKG] Detected package: " + packageName);

    // === ПУТИ-КОНДИДАТЫ ===
    const candidates = [
        "/data/data/" + packageName + "/libTool.so",
        "/data/user/0/" + packageName + "/libTool.so"
    ];

    // === УТИЛИТЫ ===
    const libc = Process.getModuleByName("libc.so");
    const openF   = new NativeFunction(libc.getExportByName("open"),   "int", ["pointer", "int", "int"]);
    const readF   = new NativeFunction(libc.getExportByName("read"),   "int", ["int", "pointer", "int"]);
    const writeF  = new NativeFunction(libc.getExportByName("write"),  "int", ["int", "pointer", "int"]);
    const closeF  = new NativeFunction(libc.getExportByName("close"),  "int", ["int"]);
    const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 64, O_TRUNC = 512;

    function fileExists(path) {
        const fd = openF(Memory.allocUtf8String(path), O_RDONLY, 0);
        if (fd < 0) return false;
        closeF(fd);
        return true;
    }

    function copyFile(src, dst) {
        try {
            const fd = openF(Memory.allocUtf8String(src), O_RDONLY, 0);
            if (fd < 0) { console.log("[COPY] Cannot open src: " + src); return false; }
            const fd2 = openF(Memory.allocUtf8String(dst), O_WRONLY | O_CREAT | O_TRUNC, 420);
            if (fd2 < 0) { closeF(fd); console.log("[COPY] Cannot create dst: " + dst); return false; }
            const buf = Memory.alloc(65536);
            let total = 0;
            while (true) {
                const n = readF(fd, buf, 65536);
                if (n <= 0) break;
                writeF(fd2, buf, n);
                total += n;
            }
            closeF(fd);
            closeF(fd2);
            console.log("[COPY] " + total + " bytes -> " + dst);
            return total > 0;
        } catch (e) {
            console.log("[COPY] ERR: " + e.message);
            return false;
        }
    }

    // === ВЫБОР ПУТИ ===
    let loadPath = null;

    if (!fileExists(SRC_PATH)) {
        console.log("[PREP] Source not found: " + SRC_PATH);
    } else {
        for (const dst of candidates) {
            if (fileExists(dst)) {
                loadPath = dst;
                console.log("[PREP] Using existing: " + dst);
                break;
            }
            console.log("[PREP] Trying to copy to: " + dst);
            if (copyFile(SRC_PATH, dst)) {
                loadPath = dst;
                break;
            }
        }
    }

    if (!loadPath) {
        console.log("[PREP] All copy attempts failed, will try original path");
        loadPath = SRC_PATH;
    }

    // === ПОИСК dlopen ===
    let dlopenPtr = null, dlerrorPtr = null;
    const dlModules = ["libdl.so", "linker64", "linker"];
    const dlopenNames = ["dlopen", "__loader_dlopen", "android_dlopen_ext"];

    for (const modName of dlModules) {
        const mod = Process.findModuleByName(modName);
        if (!mod) continue;
        for (const fnName of dlopenNames) {
            try {
                const ptr = mod.getExportByName(fnName);
                if (ptr && !ptr.isNull()) { dlopenPtr = ptr; break; }
            } catch (e) {}
        }
        if (dlopenPtr) break;
    }

    for (const modName of dlModules) {
        const mod = Process.findModuleByName(modName);
        if (!mod) continue;
        try {
            const ptr = mod.getExportByName("dlerror");
            if (ptr && !ptr.isNull()) { dlerrorPtr = ptr; break; }
        } catch (e) {}
        if (dlerrorPtr) break;
    }

    if (!dlopenPtr) {
        console.log("[LOAD] FATAL: dlopen not found");
    } else {
        const dlopen = new NativeFunction(dlopenPtr, "pointer", ["pointer", "int"]);
        const RTLD_NOW = 2;
        const dlerror = dlerrorPtr ? new NativeFunction(dlerrorPtr, "pointer", []) : null;

        function getDlError() {
            if (!dlerror) return "dlerror unavailable";
            try {
                const p = dlerror();
                return p.isNull() ? "unknown" : p.readUtf8String();
            } catch (e) { return "read err: " + e.message; }
        }

        // === ЗАГРУЗКА ===
        console.log("[LOAD] Loading: " + loadPath);
        const handle = dlopen(Memory.allocUtf8String(loadPath), RTLD_NOW);

        if (handle.isNull()) {
            console.log("[LOAD] FAILED: " + getDlError());

            if (loadPath !== SRC_PATH && fileExists(SRC_PATH)) {
                console.log("[LOAD] Retrying from: " + SRC_PATH);
                const h2 = dlopen(Memory.allocUtf8String(SRC_PATH), RTLD_NOW);
                if (h2.isNull()) {
                    console.log("[LOAD] RETRY FAILED: " + getDlError());
                    console.log("[HINT] Run: su -c setenforce 0");
                } else {
                    console.log("[LOAD] SUCCESS on retry, handle=" + h2);
                }
            }
        } else {
            console.log("[LOAD] SUCCESS, handle=" + handle);
            const mod = Process.findModuleByName("libTool.so");
            if (mod) console.log("[LOAD] base=" + mod.base + " size=" + mod.size);
        }
    }
}

console.log("[+] Script finished");