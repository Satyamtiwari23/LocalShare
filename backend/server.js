
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = "https://satyamtiwari23.github.io";

const TEMP_DIR = path.join(__dirname, "temp-sessions");

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const CHUNK_SIZE = 5 * 1024 * 1024;
const SESSION_TTL = 2 * 60 * 60 * 1000;

fs.mkdirSync(TEMP_DIR, { recursive: true });

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// CORS: allow the GitHub Pages frontend.
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin === FRONTEND_ORIGIN) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS"
        );
        res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type"
        );
    }

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

// In-memory session state.
// Render restarts will reset this state.
let activeSession = null;

const activeUploads = new Map();

const chunkUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: CHUNK_SIZE,
        files: 1
    }
});

function safeFileName(name) {
    return path.basename(name)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(-150) || "uploaded-file";
}

function getBaseUrl(req) {
    return process.env.RENDER_EXTERNAL_URL ||
        `${req.protocol}://${req.get("host")}`;
}

function countFiles(directory) {
    if (!directory || !fs.existsSync(directory)) return 0;

    return fs.readdirSync(directory, { withFileTypes: true })
        .reduce((count, entry) => {
            if (entry.name.startsWith(".")) return count;

            const fullPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                return count + countFiles(fullPath);
            }

            return count + 1;
        }, 0);
}

function getStatus(req) {
    const running = Boolean(activeSession);

    return {
        ok: true,
        running,
        status: running ? "running" : "stopped",
        folderName: "Temporary session folder",
        folder: "Temporary session folder",
        localIp: "Cloud hosted",
        port: PORT,
        url: running ? activeSession.publicUrl : "",
        publicUrl: running ? activeSession.publicUrl : "",
        scope: "public",
        filesAvailable: running
            ? countFiles(activeSession.directory)
            : 0
    };
}

function requireActiveSession(req, res, next) {
    if (!activeSession) {
        return res.status(400).json({
            ok: false,
            error: "No active sharing session. Start hosting first."
        });
    }

    next();
}

// Health check.
app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "LocalShare API",
        status: "online"
    });
});

app.get("/api/status", (req, res) => {
    res.json(getStatus(req));
});

// Start one sharing session.
app.post("/api/start", async (req, res) => {
    try {
        if (activeSession) {
            return res.status(409).json({
                ok: false,
                error: "Server Busy. A sharing session is already active."
            });
        }

        const sessionId = crypto.randomUUID();
        const directory = path.join(TEMP_DIR, sessionId);

        await fs.promises.mkdir(directory, { recursive: true });

        const publicUrl =
            `${getBaseUrl(req)}/s/${sessionId}`;

        activeSession = {
            id: sessionId,
            directory,
            publicUrl,
            startedAt: Date.now()
        };

        activeUploads.clear();

        console.log("LocalShare session started:", sessionId);

        res.json({
            ...getStatus(req),
            ok: true,
            running: true,
            status: "running",
            url: publicUrl,
            publicUrl,
            scope: "public"
        });
    } catch (error) {
        console.error("Start session failed:", error);

        res.status(500).json({
            ok: false,
            error: "Could not start sharing session."
        });
    }
});

// Initialize a file upload.
app.post(
    "/api/upload/init",
    requireActiveSession,
    (req, res) => {
        const {
            uploadId,
            fileName,
            fileSize,
            totalChunks
        } = req.body || {};

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
                error: "Invalid upload details. Maximum file size is 25 MB."
            });
        }

        if (activeUploads.has(uploadId)) {
            return res.status(409).json({
                ok: false,
                error: "Upload ID already exists."
            });
        }

        activeUploads.set(uploadId, {
            sessionId: activeSession.id,
            fileName: fileName.trim(),
            fileSize,
            totalChunks,
            receivedChunks: new Set()
        });

        res.json({
            ok: true,
            uploadId,
            chunkSize: CHUNK_SIZE,
            totalChunks
        });
    }
);

// Receive an individual chunk.
app.post(
    "/api/upload/chunk",
    requireActiveSession,
    chunkUpload.single("chunk"),
    async (req, res) => {
        try {
            const { uploadId, chunkIndex } = req.body || {};

            const upload = activeUploads.get(uploadId);
            const index = Number(chunkIndex);

            if (
                !upload ||
                upload.sessionId !== activeSession.id ||
                !Number.isSafeInteger(index) ||
                index < 0 ||
                index >= upload.totalChunks ||
                !req.file
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Invalid upload or chunk."
                });
            }

            if (upload.receivedChunks.has(index)) {
                return res.status(409).json({
                    ok: false,
                    error: "Chunk already received."
                });
            }

            const expectedSize = Math.min(
                CHUNK_SIZE,
                upload.fileSize - index * CHUNK_SIZE
            );

            if (req.file.size !== expectedSize) {
                return res.status(400).json({
                    ok: false,
                    error: "Incorrect chunk size."
                });
            }

            const chunkDirectory = path.join(
                activeSession.directory,
                ".chunks",
                uploadId
            );

            await fs.promises.mkdir(chunkDirectory, {
                recursive: true
            });

            await fs.promises.writeFile(
                path.join(chunkDirectory, `${index}.part`),
                req.file.buffer,
                { flag: "wx" }
            );

            upload.receivedChunks.add(index);

            res.json({
                ok: true,
                uploadId,
                chunkIndex: index
            });
        } catch (error) {
            console.error("Chunk upload failed:", error);

            res.status(500).json({
                ok: false,
                error: "Could not save file chunk."
            });
        }
    }
);

// Assemble all chunks into one file.
app.post(
    "/api/upload/finalize",
    requireActiveSession,
    async (req, res) => {
        try {
            const {
                uploadId,
                fileName,
                totalChunks,
                fileSize
            } = req.body || {};

            const upload = activeUploads.get(uploadId);

            if (
                !upload ||
                upload.sessionId !== activeSession.id ||
                upload.fileName !== fileName ||
                upload.totalChunks !== totalChunks ||
                upload.fileSize !== fileSize
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "Upload details do not match."
                });
            }

            if (upload.receivedChunks.size !== totalChunks) {
                return res.status(400).json({
                    ok: false,
                    error: "Some chunks are missing."
                });
            }

            const chunkDirectory = path.join(
                activeSession.directory,
                ".chunks",
                uploadId
            );

            const storedName =
                `${crypto.randomUUID()}-${safeFileName(fileName)}`;

            const outputPath = path.join(
                activeSession.directory,
                storedName
            );

            const output = fs.createWriteStream(outputPath, {
                flags: "wx"
            });

            let writtenBytes = 0;

            try {
                for (let index = 0; index < totalChunks; index++) {
                    const chunkPath = path.join(
                        chunkDirectory,
                        `${index}.part`
                    );

                    const chunk = await fs.promises.readFile(chunkPath);

                    writtenBytes += chunk.length;

                    if (writtenBytes > fileSize) {
                        throw new Error("File size exceeded.");
                    }

                    if (!output.write(chunk)) {
                        await new Promise(resolve =>
                            output.once("drain", resolve)
                        );
                    }
                }

                if (writtenBytes !== fileSize) {
                    throw new Error("File size mismatch.");
                }

                await new Promise((resolve, reject) => {
                    output.once("error", reject);
                    output.end(resolve);
                });

                await fs.promises.rm(chunkDirectory, {
                    recursive: true,
                    force: true
                });

                activeUploads.delete(uploadId);

                res.json({
                    ok: true,
                    fileName,
                    storedName,
                    fileSize: writtenBytes,
                    message: "File uploaded successfully."
                });
            } catch (error) {
                output.destroy();

                await fs.promises.rm(outputPath, {
                    force: true
                });

                throw error;
            }
        } catch (error) {
            console.error("Finalize failed:", error);

            res.status(500).json({
                ok: false,
                error: "Could not assemble uploaded file."
            });
        }
    }
);

// List files in a public sharing session.
app.get("/s/:sessionId", (req, res) => {
    if (
        !activeSession ||
        req.params.sessionId !== activeSession.id
    ) {
        return res.status(404).send("This sharing session is no longer available.");
    }

    res.type("html").send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>LocalShare - Shared Files</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    max-width: 800px;
                    margin: 40px auto;
                    padding: 20px;
                    background: #101827;
                    color: white;
                }
                a { color: #60a5fa; }
                li { margin: 14px 0; }
            </style>
        </head>
        <body>
            <h1>LocalShare</h1>
            <p>Files shared with you</p>
            <div id="files">Loading files...</div>
            <script>
                fetch("/s/${req.params.sessionId}/files")
                    .then(response => {
                        if (!response.ok) throw new Error("Unavailable");
                        return response.json();
                    })
                    .then(files => {
                        const container = document.getElementById("files");
                        container.textContent = "";

                        if (!files.length) {
                            container.textContent = "No files shared yet.";
                            return;
                        }

                        const list = document.createElement("ul");

                        files.forEach(file => {
                            const item = document.createElement("li");
                            const link = document.createElement("a");

                            link.href = file.url;
                            link.textContent = file.name;
                            link.download = file.name;

                            item.appendChild(link);
                            list.appendChild(item);
                        });

                        container.appendChild(list);
                    })
                    .catch(() => {
                        document.getElementById("files").textContent =
                            "Could not load shared files.";
                    });
            </script>
        </body>
        </html>
    `);
});

app.get("/s/:sessionId/files", (req, res) => {
    if (
        !activeSession ||
        req.params.sessionId !== activeSession.id
    ) {
        return res.status(404).json({
            error: "Sharing session not found."
        });
    }

    const files = fs.readdirSync(activeSession.directory, {
        withFileTypes: true
    })
        .filter(entry =>
            entry.isFile() && !entry.name.startsWith(".")
        )
        .map(entry => ({
            name: entry.name.replace(/^[0-9a-f-]{36}-/i, ""),
            url: `/s/${activeSession.id}/file/${encodeURIComponent(entry.name)}`
        }));

    res.json(files);
});

// Download a shared file.
app.get("/s/:sessionId/file/:fileName", (req, res) => {
    if (
        !activeSession ||
        req.params.sessionId !== activeSession.id
    ) {
        return res.status(404).send("Sharing session not found.");
    }

    const fileName = path.basename(req.params.fileName);
    const filePath = path.join(activeSession.directory, fileName);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(404).send("File not found.");
    }

    res.download(filePath, fileName.replace(/^[0-9a-f-]{36}-/i, ""));
});

// Stop hosting and delete temporary files.
app.post("/api/stop", async (req, res) => {
    try {
        if (activeSession) {
            await fs.promises.rm(activeSession.directory, {
                recursive: true,
                force: true
            });
        }

        activeSession = null;
        activeUploads.clear();

        res.json({
            ok: true,
            running: false,
            status: "stopped",
            filesAvailable: 0
        });
    } catch (error) {
        console.error("Stop failed:", error);

        res.status(500).json({
            ok: false,
            error: "Could not stop sharing."
        });
    }
});

// Automatically expire old sessions.
const cleanupTimer = setInterval(async () => {
    if (
        activeSession &&
        Date.now() - activeSession.startedAt > SESSION_TTL
    ) {
        console.log("Expiring LocalShare session.");

        await fs.promises.rm(activeSession.directory, {
            recursive: true,
            force: true
        }).catch(console.error);

        activeSession = null;
        activeUploads.clear();
    }
}, 60 * 1000);

cleanupTimer.unref();

// Handle unexpected errors.
app.use((error, req, res, next) => {
    console.error("Server error:", error);

    if (error instanceof multer.MulterError) {
        return res.status(400).json({
            ok: false,
            error: "Upload error: " + error.message
        });
    }

    res.status(500).json({
        ok: false,
        error: "Internal server error."
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`LocalShare backend running on port ${PORT}`);
});
