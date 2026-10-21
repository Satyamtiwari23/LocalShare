
const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");

const app = express();

const DASHBOARD_PORT = 3000;
const SHARE_PORT = 8000;

const TEMP_SESSIONS_DIR = path.join(__dirname, "temp-sessions");

const activeUploads = new Map();

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB per file
const CHUNK_SIZE = 10 * 1024 * 1024;     // 10 MB per chunk

let shareServer = null;
let cloudflaredProcess = null;
let publicUrl = null;
let cloudflaredLogs = "";

let activeSessionId = null;
let activeSessionDir = null;

fs.mkdirSync(TEMP_SESSIONS_DIR, { recursive: true });

const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
const SHARED_DIR = path.join(__dirname, "shared");

fs.mkdirSync(TEMP_SESSIONS_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, callback) => {
            if (!activeSessionDir) {
                return callback(new Error("No active sharing session."));
            }

            callback(null, activeSessionDir);
        },

        filename: (req, file, callback) => {
            // Generate a safe, unique filename rather than trusting
            // the original filename for filesystem storage.
            const safeName = path.basename(file.originalname)
                .replace(/[^a-zA-Z0-9._-]/g, "_")
                .slice(-150) || "uploaded-file";

            callback(null, `${crypto.randomUUID()}-${safeName}`);
        }
    }),

    limits: {
        fileSize: 10 * 1024 * 1024, // 100 MB per file
        files: 1                  // Maximum 20 files per request
    }
});


app.use(express.json());


const chunkStorage = multer.memoryStorage();

const chunkUpload = multer({
    storage: chunkStorage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB per chunk
        files: 1
    }
});


app.post("/api/upload/init", (req, res) => {
    if (!activeSessionDir || !activeSessionId) {
        return res.status(400).json({
            ok: false,
            error: "Start a sharing session before uploading."
        });
    }

    const { uploadId, fileName, fileSize, totalChunks } = req.body;

    if (
        typeof uploadId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(uploadId) ||
        typeof fileName !== "string" ||
        !fileName.trim() ||
        !Number.isSafeInteger(fileSize) ||
        fileSize < 1 ||
        fileSize > MAX_FILE_SIZE ||
        !Number.isSafeInteger(totalChunks) ||
        totalChunks !== Math.ceil(fileSize / CHUNK_SIZE)
    ) {
        return res.status(400).json({
            ok: false,
            error: "Invalid upload details or file exceeds the 100 MB limit."
        });
    }

    if (activeUploads.has(uploadId)) {
        return res.status(409).json({
            ok: false,
            error: "This upload ID is already registered."
        });
    }

    activeUploads.set(uploadId, {
        sessionId: activeSessionId,
        fileName: fileName.trim(),
        fileSize,
        totalChunks,
        receivedChunks: new Set()
    });

    return res.json({
        ok: true,
        uploadId,
        chunkSize: CHUNK_SIZE,
        totalChunks
    });
});



app.post(
    "/api/upload/chunk",
    chunkUpload.single("chunk"),
    async (req, res) => {
        try {
            if (!activeSessionDir || !activeSessionId) {
                return res.status(400).json({
                    ok: false,
                    error: "No active sharing session."
                });
            }

            const { uploadId, chunkIndex } = req.body;

            if (
                typeof uploadId !== "string" ||
                !/^[a-zA-Z0-9_-]{1,100}$/.test(uploadId) ||
                !/^\d+$/.test(chunkIndex) ||
                !req.file
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid chunk upload data."
                });
            }

            const index = Number(chunkIndex);
            const upload = activeUploads.get(uploadId);

            if (
                !upload ||
                upload.sessionId !== activeSessionId ||
                !Number.isSafeInteger(index) ||
                index < 0 ||
                index >= upload.totalChunks
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Upload not registered or chunk index invalid."
                });
            }

            if (upload.receivedChunks.has(index)) {
                return res.status(409).json({
                    ok: false,
                    error: "This chunk has already been received."
                });
            }

            // Verify the expected size of this chunk.
            const expectedChunkSize = Math.min(
                CHUNK_SIZE,
                upload.fileSize - index * CHUNK_SIZE
            );

            if (req.file.size !== expectedChunkSize) {
                return res.status(400).json({
                    ok: false,
                    error: "Chunk size does not match the expected size."
                });
            }

            const chunkDir = path.join(
                activeSessionDir,
                ".chunks",
                uploadId
            );

            await fs.promises.mkdir(chunkDir, { recursive: true });

            const chunkPath = path.join(chunkDir, `${index}.part`);

            await fs.promises.writeFile(chunkPath, req.file.buffer, {
                flag: "wx"
            });

            upload.receivedChunks.add(index);

            return res.json({
                ok: true,
                uploadId,
                chunkIndex: index,
                receivedBytes: req.file.size
            });
        } catch (error) {
            console.error("Chunk upload failed:", error.message);

            return res.status(500).json({
                ok: false,
                error: "Could not save the uploaded chunk."
            });
        }
    }
);




app.post("/api/upload/finalize", async (req, res) => {
    try {
        if (!activeSessionDir || !activeSessionId) {
            return res.status(400).json({
                ok: false,
                error: "No active sharing session."
            });
        }

        const { uploadId, fileName, totalChunks, fileSize } = req.body;

        if (
            typeof uploadId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(uploadId) ||
            typeof fileName !== "string" ||
            !fileName.trim() ||
            !Number.isSafeInteger(totalChunks) ||
            totalChunks < 1 ||
            !Number.isSafeInteger(fileSize) ||
            fileSize < 1 ||
            fileSize > MAX_FILE_SIZE
        ) {
            return res.status(400).json({
                ok: false,
                error: "Invalid upload metadata or file exceeds the 100 MB limit."
            });
        }

        const upload = activeUploads.get(uploadId);

        if (
            !upload ||
            upload.sessionId !== activeSessionId ||
            upload.fileName !== fileName ||
            upload.totalChunks !== totalChunks ||
            upload.fileSize !== fileSize
        ) {
            return res.status(400).json({
                ok: false,
                error: "Upload metadata does not match the active upload."
            });
        }

        if (upload.receivedChunks.size !== upload.totalChunks) {
            return res.status(400).json({
                ok: false,
                message: "Upload incomplete. Some chunks are missing."
            });
        }

        const chunkDir = path.join(
            activeSessionDir,
            ".chunks",
            uploadId
        );

        const outputName = `${crypto.randomUUID()}-${path.basename(fileName)
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .slice(-150) || "uploaded-file"}`;

        const outputPath = path.join(activeSessionDir, outputName);
        const output = fs.createWriteStream(outputPath, { flags: "wx" });

        let writtenBytes = 0;

        try {
            for (let i = 0; i < totalChunks; i++) {
                const chunkPath = path.join(chunkDir, `${i}.part`);
                const chunk = await fs.promises.readFile(chunkPath);

                writtenBytes += chunk.length;

                if (writtenBytes > fileSize) {
                    throw new Error("Uploaded chunks exceed the declared file size.");
                }

                if (!output.write(chunk)) {
                    await new Promise(resolve => output.once("drain", resolve));
                }
            }

            if (writtenBytes !== fileSize) {
                throw new Error("Uploaded chunks do not match the declared file size.");
            }

            await new Promise((resolve, reject) => {
                output.end(resolve);
                output.on("error", reject);
            });

            await fs.promises.rm(chunkDir, { recursive: true, force: true });
            activeUploads.delete(uploadId);

            return res.json({
                ok: true,
                fileName,
                storedName: outputName,
                fileSize: writtenBytes,
                message: "File assembled successfully."
            });
        } catch (error) {
            output.destroy();
            await fs.promises.rm(outputPath, { force: true });
            throw error;
        }
    } catch (error) {
        console.error("Finalize upload failed:", error.message);

        return res.status(500).json({
            ok: false,
            error: "Could not assemble the uploaded file."
        });
    }
});



// Ensure the shared directory exists.
fs.mkdirSync(SHARED_DIR, { recursive: true });

// Serve the dashboard frontend.
app.use(express.static(FRONTEND_DIR));

// Find a usable local IPv4 address.
function getLocalIP() {
    const interfaces = os.networkInterfaces();

    for (const entries of Object.values(interfaces)) {
        for (const info of entries || []) {
            if (
                info.family === "IPv4" &&
                !info.internal &&
                !info.address.startsWith("169.254.")
            ) {
                return info.address;
            }
        }
    }

    return "localhost";
}



function startCloudflareTunnel() {
    return new Promise((resolve, reject) => {
        if (cloudflaredProcess) {
            return reject(new Error("Cloudflare Tunnel is already running."));
        }

        const { spawn } = require("child_process");

        publicUrl = null;
        cloudflaredLogs = "";

        cloudflaredProcess = spawn(
            "cloudflared",
            ["tunnel", "--url", `http://localhost:${SHARE_PORT}`],
            { stdio: ["ignore", "pipe", "pipe"] }
        );

        let settled = false;

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(
                    "Cloudflare URL was not generated in time. Check your internet connection and cloudflared logs."
                ));
            }
        }, 30000);

        function handleOutput(chunk) {
            const output = chunk.toString();
            cloudflaredLogs = (cloudflaredLogs + output).slice(-10000);

            const match = output.match(
                /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/
            );

            if (match) {
                publicUrl = match[0];

                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    resolve(publicUrl);
                }
            }
        }

        cloudflaredProcess.stdout.on("data", handleOutput);
        cloudflaredProcess.stderr.on("data", handleOutput);

        cloudflaredProcess.on("error", (error) => {
            clearTimeout(timeout);
            cloudflaredProcess = null;

            if (!settled) {
                settled = true;
                reject(error);
            }
        });

        cloudflaredProcess.on("close", (code) => {
            cloudflaredProcess = null;
            publicUrl = null;

            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(
                    `Cloudflare Tunnel exited before generating a URL (code ${code}).`
                ));
            }
        });
    });
}




function getStatus() {
    const running = Boolean(shareServer?.listening);
    const localIP = getLocalIP();

    let fileCount = 0;

    function countFiles(directory) {
        if (!fs.existsSync(directory)) return 0;

        return fs.readdirSync(directory, { withFileTypes: true })
            .reduce((count, entry) => {
                // Ignore internal chunk directories and hidden files.
                if (entry.name.startsWith(".")) return count;

                const fullPath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    return count + countFiles(fullPath);
                }

                return count + 1;
            }, 0);
    }

    if (activeSessionDir) {
        fileCount = countFiles(activeSessionDir);
    }

    return {
        ok: true,
        running,
        status: running ? "running" : "stopped",
        folderName: "shared",
        folder: "shared",
        localIp: localIP,
        port: SHARE_PORT,
        url: publicUrl || (running ? `http://${localIP}:${SHARE_PORT}` : ""),
        publicUrl: publicUrl || "",
        scope: publicUrl ? "public internet" : "local network",
        cloudflareRunning: Boolean(cloudflaredProcess),
        filesAvailable: fileCount
    };
}


// Dashboard status API.
app.get("/api/status", (req, res) => {
    res.json(getStatus());
});


app.post("/api/start", async (req, res) => {
    if (shareServer?.listening) {
        return res.json(getStatus());
    }

    // Create a fresh temporary upload session.
    activeSessionId = crypto.randomUUID();
    activeSessionDir = path.join(TEMP_SESSIONS_DIR, activeSessionId);

    await fs.promises.mkdir(activeSessionDir, { recursive: true });

    activeUploads.clear();

    const shareApp = express();

    shareApp.get("/", (req, res) => {
        res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>LocalShare</title>
      </head>
      <body style="font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:20px">
        <h1>LocalShare</h1>
        <p>Files shared from this device</p>
        <div id="files">Loading files...</div>
        <script>
          fetch("/api/files")
            .then(r => r.json())
            .then(files => {
              const container = document.getElementById("files");
              container.textContent = "";

              if (!files.length) {
                container.textContent = "No files shared yet.";
                return;
              }

              files.forEach(file => {
                const row = document.createElement("p");
                const link = document.createElement("a");
                link.href = file.url;
                link.textContent = file.name;
                row.appendChild(link);
                container.appendChild(row);
              });
            })
            .catch(() => {
              document.getElementById("files").textContent =
                "Could not load files.";
            });
        </script>
      </body>
      </html>
    `);
    });

    shareApp.get("/api/files", (req, res) => {
        function listFiles(directory, relative = "") {
            return fs.readdirSync(directory, { withFileTypes: true })
                .flatMap(entry => {
                    if (entry.name.startsWith(".")) return [];

                    const absolute = path.join(directory, entry.name);
                    const relativePath = path.posix.join(relative, entry.name);

                    if (entry.isDirectory()) {
                        return listFiles(absolute, relativePath);
                    }

                    return [{
                        name: relativePath,
                        url: "/" + relativePath
                            .split("/")
                            .map(encodeURIComponent)
                            .join("/")
                    }];
                });
        }

        res.json(listFiles(activeSessionDir));
    });

    shareApp.use(express.static(activeSessionDir, {
        dotfiles: "ignore",
        index: false,
        setHeaders(res) {
            res.setHeader("Content-Disposition", "inline");
        }
    }));

    const server = shareApp.listen(SHARE_PORT, "0.0.0.0");

    server.once("error", (error) => {
        console.error("Sharing server error:", error.message);
    });

    try {
        await new Promise((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });

        shareServer = server;

        await startCloudflareTunnel();

        res.json(getStatus());
    } catch (error) {
        console.error("Hosting startup failed:", error.message);

        if (shareServer?.listening) {
            await new Promise(resolve => shareServer.close(resolve));
        } else if (server.listening) {
            await new Promise(resolve => server.close(resolve));
        }

        shareServer = null;

        if (cloudflaredProcess) {
            cloudflaredProcess.kill("SIGTERM");
            cloudflaredProcess = null;
        }

        publicUrl = null;

        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});


// Stop sharing.

app.post("/api/stop", async (req, res) => {
    try {
        // Stop the Cloudflare tunnel first.
        const tunnel = cloudflaredProcess;
        cloudflaredProcess = null;
        publicUrl = null;

        if (tunnel && !tunnel.killed) {
            await new Promise(resolve => {
                const forceTimeout = setTimeout(() => {
                    if (tunnel.exitCode === null) {
                        tunnel.kill("SIGKILL");
                    }
                    resolve();
                }, 5000);

                tunnel.once("close", () => {
                    clearTimeout(forceTimeout);
                    resolve();
                });

                tunnel.kill("SIGTERM");
            });
        }

        // Stop the file-sharing server.
        const server = shareServer;
        shareServer = null;

        if (server?.listening) {
            await new Promise((resolve, reject) => {
                server.close(error => {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }

        // Delete temporary files and reset the active session.
        if (activeSessionDir) {
            await fs.promises.rm(activeSessionDir, {
                recursive: true,
                force: true
            });
        }

        activeSessionDir = null;
        activeSessionId = null;
        activeUploads.clear();

        return res.json(getStatus());
    } catch (error) {
        console.error("Stop Hosting failed:", error.message);

        return res.status(500).json({
            ok: false,
            error: "Could not stop hosting: " + error.message
        });
    }
});


// Start the dashboard backend.
app.listen(DASHBOARD_PORT, "127.0.0.1", () => {
    console.log(`LocalShare dashboard: http://localhost:${DASHBOARD_PORT}`);
    console.log(`Files to share: ${SHARED_DIR}`);
});
