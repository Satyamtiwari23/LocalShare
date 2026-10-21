/* =========================================================
   LocalShare — script.js
   Vanilla JS • API-ready • no fake server behaviour
   ========================================================= */

(() => {
    "use strict";

    /* ---------------------------------------------------------
       Configuration
       --------------------------------------------------------- */
    // Leave empty to call the same origin, e.g. "http://localhost:3000"
    const API_BASE = "";

    const ENDPOINTS = {
        status: "/api/status",
        start: "/api/start",
        stop: "/api/stop",
        uploadInit: "/api/upload/init",
        uploadChunk: "/api/upload/chunk",
        uploadFinalize: "/api/upload/finalize",
    };

    const REQUEST_TIMEOUT = 12000;

    /* ---------------------------------------------------------
       State
       --------------------------------------------------------- */
    const state = {
        backend: "unknown", // unknown | online | offline
        status: "stopped", // stopped | starting | running | stopping | error
        busy: false,
        folderName: null,
        shareUrl: null,
    };

    /* ---------------------------------------------------------
       DOM references
       --------------------------------------------------------- */
    const $ = (id) => document.getElementById(id);

    const el = {
        scrollProgress: $("scrollProgress"),
        nav: $("nav"),

        backendPill: $("backendPill"),
        backendText: $("backendText"),

        heroInner: $("heroInner"),
        controlCard: $("controlCard"),

        statusDot: $("statusDot"),
        statusText: $("statusText"),
        statusSpinner: $("statusSpinner"),
        errorBox: $("errorBox"),

        folderPath: $("folderPath"),
        chooseFolderBtn: $("chooseFolderBtn"),

        startBtn: $("startBtn"),
        stopBtn: $("stopBtn"),
        loadingIndicator: $("loadingIndicator"),
        loadingText: $("loadingText"),

        shareSection: $("shareSection"),
        shareUrl: $("shareUrl"),
        copyBtn: $("copyBtn"),
        copyBtnLabel: $("copyBtnLabel"),
        openBtn: $("openBtn"),
        linkScope: $("linkScope"),
        linkMessage: $("linkMessage"),

        infoStatus: $("infoStatus"),
        infoIp: $("infoIp"),
        infoPort: $("infoPort"),
        infoFolder: $("infoFolder"),
        infoFiles: $("infoFiles"),
        // File upload
        fileInput: $("fileInput"),
        selectFilesBtn: $("selectFilesBtn"),
        selectedFilesText: $("selectedFilesText"),
        uploadFilesBtn: $("uploadFilesBtn"),
        uploadFileList: $("uploadFileList"),
        uploadError: $("uploadError"),
        uploadMessage: $("uploadMessage"),
    };

    /* ---------------------------------------------------------
       Small helpers
       --------------------------------------------------------- */
    const STATUS_LABELS = {
        stopped: "Stopped",
        starting: "Starting",
        running: "Running",
        stopping: "Stopping",
        error: "Error",
    };

    function displayStatus(status) {
        return STATUS_LABELS[status] || "Unknown";
    }

    function normalizeStatus(value) {
        const raw = String(value || "").toLowerCase().trim();
        if (!raw) return "stopped";
        if (["running", "started", "active", "hosting"].includes(raw)) return "running";
        if (["starting", "pending"].includes(raw)) return "starting";
        if (["stopping", "shutting-down", "shuttingdown"].includes(raw)) return "stopping";
        if (["error", "failed", "failure"].includes(raw)) return "error";
        return "stopped";
    }

    function normalizePayload(json) {
        if (!json || typeof json !== "object") return {};
        if (json.data && typeof json.data === "object" && !Array.isArray(json.data)) {
            return { ...json, ...json.data };
        }
        return json;
    }

    function firstDefined(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && value !== "") return value;
        }
        return null;
    }

    function setBackend(status, text) {
        state.backend = status;
        if (el.backendPill) el.backendPill.dataset.state = status;
        if (el.backendText) el.backendText.textContent = text;
    }

    function setStatus(status) {
        state.status = status;
        if (el.statusDot) el.statusDot.dataset.status = status;
        if (el.controlCard) el.controlCard.dataset.status = status;
        if (el.statusText) el.statusText.textContent = displayStatus(status);
        renderControls();
    }

    function renderControls() {
        const busy = state.busy;
        const status = state.status;
        const transitioning = status === "starting" || status === "stopping";
        const errorUnknown = status === "error";

        if (el.startBtn) {
            el.startBtn.disabled =
                busy || transitioning || !(status === "stopped" || errorUnknown);
        }

        if (el.stopBtn) {
            el.stopBtn.disabled = busy || transitioning || status !== "running";
        }

        if (el.chooseFolderBtn) {
            el.chooseFolderBtn.disabled = busy || transitioning || status === "running";
        }

        if (el.statusSpinner) {
            el.statusSpinner.hidden = !(busy || transitioning);
        }
        if (el.uploadFilesBtn) {
            el.uploadFilesBtn.disabled =
                state.status !== "running" ||
                state.busy ||
                selectedFiles.length === 0;
        }
    }

    function setBusy(busy, text = "Working…") {
        state.busy = busy;
        if (el.loadingIndicator) el.loadingIndicator.hidden = !busy;
        if (el.loadingText) el.loadingText.textContent = text;
        renderControls();
    }

    function showError(message) {
        if (!el.errorBox) return;
        el.errorBox.textContent = message || "";
        el.errorBox.hidden = !message;
    }

    function clearError() {
        if (!el.errorBox) return;
        el.errorBox.textContent = "";
        el.errorBox.hidden = true;
    }

    function updateInfo(data = {}) {
        const payload = data || {};

        const ip = firstDefined(payload.localIp, payload.ip, payload.address);
        const port = firstDefined(payload.port, payload.serverPort);
        const folder = firstDefined(
            payload.folder,
            payload.folderName,
            payload.sharedFolder
        );
        const files = firstDefined(
            payload.filesAvailable,
            payload.fileCount,
            payload.files
        );

        if (el.infoStatus) el.infoStatus.textContent = displayStatus(state.status);
        if (el.infoIp) el.infoIp.textContent = ip != null ? String(ip) : "—";
        if (el.infoPort) el.infoPort.textContent = port != null ? String(port) : "—";
        if (el.infoFolder) el.infoFolder.textContent = folder != null ? String(folder) : "—";

        if (el.infoFiles) {
            el.infoFiles.textContent =
                typeof files === "number" && Number.isFinite(files) ? String(files) : "—";
        }
    }

    /* ---------------------------------------------------------
       API layer
       --------------------------------------------------------- */
    async function apiRequest(endpointName, { method = "GET", body = null } = {}) {
        const path = ENDPOINTS[endpointName];
        if (!path) throw new Error("Unknown API endpoint.");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
            const response = await fetch(API_BASE + path, {
                method,
                headers: body ? { "Content-Type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal,
                cache: "no-store",
            });

            const rawText = await response.text();
            let json = {};

            if (rawText) {
                try {
                    json = JSON.parse(rawText);
                } catch {
                    throw new Error("The backend returned an invalid response.");
                }
            }

            if (!response.ok) {
                const message =
                    (json && (json.error || json.message)) ||
                    `Request failed with status ${response.status}.`;
                const error = new Error(message);
                error.response = json;
                error.statusCode = response.status;
                throw error;
            }

            return json;
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error("The request timed out.");
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /* ---------------------------------------------------------
       UI state application
       --------------------------------------------------------- */
    function applyRunning(data = {}) {
        const payload = normalizePayload(data);
        const url = firstDefined(
            payload.url,
            payload.shareUrl,
            payload.sharingUrl,
            payload.link
        );

        state.shareUrl = url ? String(url) : null;

        setStatus("running");
        updateInfo(payload);

        if (el.shareSection) el.shareSection.hidden = false;

        if (el.shareUrl) {
            el.shareUrl.value = state.shareUrl || "";
            el.shareUrl.placeholder = "Waiting for the server…";
        }

        if (el.linkScope) {
            el.linkScope.textContent =
                payload.scope === "public" ? "Public tunnel" : "Local network";
        }

        if (el.linkMessage) {
            if (state.shareUrl) {
                el.linkMessage.hidden = true;
                el.linkMessage.textContent = "";
            } else {
                el.linkMessage.hidden = false;
                el.linkMessage.textContent =
                    "The server is running but did not return a sharing link. Check the backend response.";
            }
        }

        clearError();
    }

    function applyStopped(data = {}) {
        const payload = normalizePayload(data);

        state.shareUrl = null;
        setStatus("stopped");

        if (el.shareSection) el.shareSection.hidden = true;
        if (el.shareUrl) el.shareUrl.value = "";
        if (el.linkMessage) {
            el.linkMessage.hidden = true;
            el.linkMessage.textContent = "";
        }
        if (el.linkScope) el.linkScope.textContent = "—";

        updateInfo(payload);
    }

    /* ---------------------------------------------------------
       Refresh status
       --------------------------------------------------------- */
    async function refreshStatus({ silent = false } = {}) {
        try {
            const response = await apiRequest("status", { method: "GET" });
            const data = normalizePayload(response);

            setBackend("online", "Backend connected");

            const rawStatus = firstDefined(data.status, data.state);
            const status = normalizeStatus(
                rawStatus || (data.running === true ? "running" : "stopped")
            );

            if (status === "running") {
                applyRunning(data);
            } else if (status === "starting" || status === "stopping") {
                setStatus(status);
                updateInfo(data);
            } else if (status === "error") {
                setStatus("error");
                updateInfo(data);
                showError(
                    firstDefined(data.error, data.message) ||
                    "The backend reported an error."
                );
            } else {
                applyStopped(data);
            }

            return true;
        } catch (error) {
            setBackend("offline", "Backend unavailable");

            if (!silent) {
                showError(
                    "Could not reach the backend. Start the backend server, then refresh this page."
                );
            }

            return false;
        }
    }


    async function chooseFolder() {
        state.folderName = "shared";

        if (el.folderPath) {
            el.folderPath.textContent = "Temporary session folder";
            el.folderPath.classList.remove("is-empty");
        }

        if (el.chooseFolderBtn) {
            el.chooseFolderBtn.disabled = true;
            el.chooseFolderBtn.textContent = "Session Ready";
        }

        showError("");
    }


    /* ---------------------------------------------------------
       Start hosting
       --------------------------------------------------------- */
    async function startHosting() {
        if (state.busy) return;

        if (!state.folderName) {
            showError(
                "Choose a folder first. If folder selection is unavailable, configure the shared directory in the backend."
            );
            if (el.chooseFolderBtn) el.chooseFolderBtn.focus();
            return;
        }

        clearError();
        setBusy(true, "Starting server…");
        setStatus("starting");

        try {
            const response = await apiRequest("start", {
                method: "POST",
                body: {
                    folder: state.folderName,
                    folderName: state.folderName,
                },
            });

            const data = normalizePayload(response);
            const reportedStatus = normalizeStatus(
                firstDefined(data.status, data.state) ||
                (data.running === true ? "running" : "")
            );

            const success =
                data.ok === true ||
                data.success === true ||
                data.result === "ok" ||
                reportedStatus === "running";

            if (!success) {
                throw new Error(
                    firstDefined(data.error, data.message) ||
                    "The backend did not confirm that hosting started."
                );
            }

            setBackend("online", "Backend connected");
            applyRunning(data);
        } catch (error) {
            showError(error.message || "Failed to start hosting.");

            // Reflect the backend's real state rather than assuming failure.
            await refreshStatus({ silent: true });

            // If the state is still unknown, surface it instead of pretending.
            if (state.status === "starting") {
                setStatus("error");
                showError(
                    (error.message || "Failed to start hosting.") +
                    " The server state could not be confirmed. Reload the page to check."
                );
            }
        } finally {
            setBusy(false);
        }
    }

    /* ---------------------------------------------------------
       Stop hosting
       --------------------------------------------------------- */
    async function stopHosting() {
        if (state.busy) return;

        clearError();
        setBusy(true, "Stopping server…");
        setStatus("stopping");

        try {
            const response = await apiRequest("stop", { method: "POST" });
            const data = normalizePayload(response);
            const reportedStatus = normalizeStatus(
                firstDefined(data.status, data.state) || ""
            );

            const success =
                data.ok === true ||
                data.success === true ||
                data.result === "ok" ||
                reportedStatus === "stopped";

            if (!success) {
                throw new Error(
                    firstDefined(data.error, data.message) ||
                    "The backend did not confirm that hosting stopped."
                );
            }

            setBackend("online", "Backend connected");
            clearError();
            applyStopped(data);
        } catch (error) {
            showError(error.message || "Failed to stop hosting.");

            await refreshStatus({ silent: true });

            if (state.status === "stopping") {
                setStatus("error");
                showError(
                    (error.message || "Failed to stop hosting.") +
                    " The server state could not be confirmed. Reload the page to check."
                );
            }
        } finally {
            setBusy(false);
        }
    }

    /* ---------------------------------------------------------
       Copy link
       --------------------------------------------------------- */
    async function copyLink() {
        if (!state.shareUrl) {
            showError("There is no sharing link to copy yet.");
            return;
        }

        if (!navigator.clipboard || !navigator.clipboard.writeText) {
            showError(
                "Clipboard access is not available in this browser. Select the link and copy it manually."
            );
            return;
        }

        try {
            await navigator.clipboard.writeText(state.shareUrl);

            if (el.copyBtnLabel) {
                const original = el.copyBtnLabel.textContent;
                el.copyBtnLabel.textContent = "Copied!";
                if (el.copyBtn) el.copyBtn.disabled = true;

                window.setTimeout(() => {
                    if (el.copyBtnLabel) el.copyBtnLabel.textContent = original;
                    if (el.copyBtn) el.copyBtn.disabled = false;
                }, 1600);
            }
        } catch {
            showError(
                "Could not copy the link. Your browser may be blocking clipboard access."
            );
        }
    }


    /* ---------------------------------------------------------
       File selection
       --------------------------------------------------------- */
    const selectedFiles = [];

    function formatFileSize(bytes) {
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }

        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function renderSelectedFiles() {
        if (!el.uploadFileList || !el.selectedFilesText) return;

        el.uploadFileList.replaceChildren();

        selectedFiles.forEach((file, index) => {
            const item = document.createElement("div");
            item.className = "upload-file-item";

            const details = document.createElement("span");
            details.textContent = `${file.name} (${formatFileSize(file.size)})`;

            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "btn btn--ghost";
            removeBtn.textContent = "Remove";
            removeBtn.addEventListener("click", () => {
                selectedFiles.splice(index, 1);
                renderSelectedFiles();
            });

            item.append(details, removeBtn);
            el.uploadFileList.appendChild(item);
        });

        el.selectedFilesText.textContent = selectedFiles.length
            ? `${selectedFiles.length} file(s) selected`
            : "No files selected";

        if (el.uploadFilesBtn) {
            el.uploadFilesBtn.disabled =
                selectedFiles.length === 0 || state.status !== "running" || state.busy;
        }
    }

    function selectFiles() {
        if (state.status !== "running") {
            showUploadMessage("Start Hosting before uploading files.", true);
            return;
        }

        el.fileInput?.click();
    }

    function handleFileSelection(event) {
        const files = Array.from(event.target.files || []);
        const maxFileSize = 100 * 1024 * 1024;

        const oversized = files.filter(file => file.size > maxFileSize);

        if (oversized.length) {
            showUploadMessage(
                `Each file must be 100 MB or smaller. Oversized: ${oversized.map(file => file.name).join(", ")}`,
                true
            );
        } else {
            showUploadMessage("", false);
        }

        files
            .filter(file => file.size <= maxFileSize)
            .forEach(file => {
                const duplicate = selectedFiles.some(
                    existing => existing.name === file.name &&
                        existing.size === file.size &&
                        existing.lastModified === file.lastModified
                );

                if (!duplicate) selectedFiles.push(file);
            });

        event.target.value = "";
        renderSelectedFiles();
    }



    /* ---------------------------------------------------------
       Drag and drop files
       --------------------------------------------------------- */
    function initDragAndDrop() {
        const dropArea = $("uploadArea");

        if (!dropArea) return;

        dropArea.addEventListener("dragover", (event) => {
            event.preventDefault();

            if (state.status !== "running" || state.busy) return;

            dropArea.classList.add("is-dragging");
            event.dataTransfer.dropEffect = "copy";
        });

        dropArea.addEventListener("dragleave", (event) => {
            if (!dropArea.contains(event.relatedTarget)) {
                dropArea.classList.remove("is-dragging");
            }
        });

        dropArea.addEventListener("drop", (event) => {
            event.preventDefault();
            dropArea.classList.remove("is-dragging");

            if (state.status !== "running") {
                showUploadMessage("Start Hosting before adding files.", true);
                return;
            }

            if (state.busy) {
                showUploadMessage("Please wait for the current upload to finish.", true);
                return;
            }

            const files = Array.from(event.dataTransfer?.files || []);

            if (files.length === 0) {
                showUploadMessage("No files were detected. Try dropping files from Finder.", true);
                return;
            }

            const maxFileSize = 100 * 1024 * 1024;
            const oversized = files.filter(file => file.size > maxFileSize);

            if (oversized.length) {
                showUploadMessage(
                    `Files over 100 MB were skipped: ${oversized.map(file => file.name).join(", ")}`,
                    true
                );
            } else {
                showUploadMessage("", false);
            }

            files
                .filter(file => file.size <= maxFileSize)
                .forEach(file => {
                    const duplicate = selectedFiles.some(
                        existing =>
                            existing.name === file.name &&
                            existing.size === file.size &&
                            existing.lastModified === file.lastModified
                    );

                    if (!duplicate) selectedFiles.push(file);
                });

            renderSelectedFiles();
        });

        // Prevent the browser from opening a dropped file.
        document.addEventListener("dragover", (event) => {
            event.preventDefault();
        });

        document.addEventListener("drop", (event) => {
            if (!dropArea.contains(event.target)) {
                event.preventDefault();
            }
        });
    }


    function showUploadMessage(message, isError = false) {
        if (el.uploadError) {
            el.uploadError.hidden = !isError || !message;
            el.uploadError.textContent = isError ? message : "";
        }

        if (el.uploadMessage) {
            el.uploadMessage.hidden = !message || isError;
            el.uploadMessage.textContent = isError ? "" : message;
        }
    }



    /* ---------------------------------------------------------
       Chunked file upload
       --------------------------------------------------------- */
    async function uploadSingleFile(file) {
        const chunkSize = 10 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);
        const uploadId = crypto.randomUUID();

        // Initialize this upload on the backend.
        const initResponse = await fetch(API_BASE + ENDPOINTS.uploadInit, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uploadId,
                fileName: file.name,
                fileSize: file.size,
                totalChunks
            })
        });

        const initData = await initResponse.json();

        if (!initResponse.ok || initData.ok !== true) {
            throw new Error(
                initData.message || initData.error || `Could not initialize ${file.name}.`
            );
        }

        // Send one chunk at a time.
        for (let index = 0; index < totalChunks; index++) {
            const start = index * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);

            const formData = new FormData();
            formData.append("uploadId", uploadId);
            formData.append("chunkIndex", String(index));
            formData.append("chunk", chunk, `${file.name}.part`);

            const response = await fetch(API_BASE + ENDPOINTS.uploadChunk, {
                method: "POST",
                body: formData
            });

            const data = await response.json();

            if (!response.ok || data.ok !== true) {
                throw new Error(
                    data.message || data.error || `Chunk ${index + 1} failed for ${file.name}.`
                );
            }

            const completedBytes = Math.min(end, file.size);
            const percent = Math.round((completedBytes / file.size) * 100);

            showUploadMessage(
                `Uploading ${file.name}: ${percent}% (${index + 1}/${totalChunks} chunks)`,
                false
            );
        }

        // Ask the backend to assemble the complete file.
        const finalizeResponse = await fetch(API_BASE + ENDPOINTS.uploadFinalize, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                uploadId,
                fileName: file.name,
                fileSize: file.size,
                totalChunks
            })
        });

        const finalizeData = await finalizeResponse.json();

        if (!finalizeResponse.ok || finalizeData.ok !== true) {
            throw new Error(
                finalizeData.message || finalizeData.error || `Could not finish uploading ${file.name}.`
            );
        }

        return finalizeData;
    }

    async function uploadSelectedFiles() {
        if (state.busy) return;

        if (state.status !== "running") {
            showUploadMessage("Start Hosting before uploading files.", true);
            return;
        }

        if (selectedFiles.length === 0) {
            showUploadMessage("Select at least one file first.", true);
            return;
        }

        const filesToUpload = [...selectedFiles];
        const failedFiles = [];

        setBusy(true, "Uploading files…");
        showUploadMessage("", false);

        try {
            for (const file of filesToUpload) {
                try {
                    await uploadSingleFile(file);
                } catch (error) {
                    failedFiles.push(`${file.name}: ${error.message}`);
                }
            }

            // Remove successfully uploaded files from the selection.
            const successfulNames = new Set(
                filesToUpload
                    .filter(file => !failedFiles.some(
                        message => message.startsWith(`${file.name}:`)
                    ))
                    .map(file => `${file.name}:${file.size}:${file.lastModified}`)
            );

            for (let i = selectedFiles.length - 1; i >= 0; i--) {
                const file = selectedFiles[i];
                const key = `${file.name}:${file.size}:${file.lastModified}`;

                if (successfulNames.has(key)) {
                    selectedFiles.splice(i, 1);
                }
            }

            if (failedFiles.length) {
                showUploadMessage(
                    `Some files could not be uploaded:\n${failedFiles.join("\n")}`,
                    true
                );
            } else {
                showUploadMessage(
                    `Successfully uploaded ${filesToUpload.length} file(s).`,
                    false
                );
            }

            renderSelectedFiles();

            // Refresh the dashboard's file count.
            await refreshStatus({ silent: true });
        } finally {
            setBusy(false);
        }
    }



    /* ---------------------------------------------------------
       Open link
       --------------------------------------------------------- */
    function openLink() {
        if (!state.shareUrl) {
            showError("There is no sharing link to open yet.");
            return;
        }

        let parsed;
        try {
            parsed = new URL(state.shareUrl);
        } catch {
            showError("The sharing link is not a valid URL.");
            return;
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            showError("Only HTTP and HTTPS sharing links can be opened.");
            return;
        }

        const newWindow = window.open(
            parsed.href,
            "_blank",
            "noopener,noreferrer"
        );

        if (!newWindow) {
            showError(
                "The browser blocked the new tab. Allow pop-ups for this page and try again."
            );
        }
    }

    /* ---------------------------------------------------------
       Scroll effects
       --------------------------------------------------------- */
    function initScrollEffects() {
        const reduceMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
        ).matches;

        const progress = el.scrollProgress;
        const nav = el.nav;
        const heroInner = el.heroInner;
        const parallaxElements = Array.from(
            document.querySelectorAll("[data-parallax]")
        ).map((node) => ({
            node,
            rate: Number.parseFloat(node.dataset.parallax) || 0,
        }));

        let ticking = false;

        function update() {
            ticking = false;

            const scrollY = window.scrollY || window.pageYOffset;
            const doc = document.documentElement;
            const maxScroll = Math.max(0, doc.scrollHeight - window.innerHeight);
            const percent = maxScroll > 0 ? (scrollY / maxScroll) * 100 : 0;

            if (progress) progress.style.width = percent + "%";
            if (nav) nav.classList.toggle("is-scrolled", scrollY > 16);

            if (!reduceMotion) {
                for (const item of parallaxElements) {
                    item.node.style.transform = `translate3d(0, ${scrollY * item.rate}px, 0)`;
                }

                if (heroInner) {
                    const heroOffset = Math.min(scrollY * 0.08, 40);
                    heroInner.style.transform = `translate3d(0, ${heroOffset}px, 0)`;
                    heroInner.style.opacity = String(
                        Math.max(0, 1 - scrollY / 700)
                    );
                }
            }
        }

        function onScroll() {
            if (!ticking) {
                ticking = true;
                window.requestAnimationFrame(update);
            }
        }

        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll, { passive: true });
        update();

        // Reveal-on-scroll
        const revealElements = document.querySelectorAll(".reveal");

        if (reduceMotion || !("IntersectionObserver" in window)) {
            revealElements.forEach((node) => node.classList.add("is-visible"));
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add("is-visible");
                        observer.unobserve(entry.target);
                    }
                });
            },
            {
                threshold: 0.12,
                rootMargin: "0px 0px -8% 0px",
            }
        );

        revealElements.forEach((node) => observer.observe(node));
    }

    /* ---------------------------------------------------------
       Event listeners & init
       --------------------------------------------------------- */
    function attachListeners() {

        if (el.selectFilesBtn) {
            el.selectFilesBtn.addEventListener("click", selectFiles);
        }

        if (el.fileInput) {
            el.fileInput.addEventListener("change", handleFileSelection);
        }

        if (el.uploadFilesBtn) {
            el.uploadFilesBtn.addEventListener("click", uploadSelectedFiles);
        }

        if (el.chooseFolderBtn) {
            el.chooseFolderBtn.addEventListener("click", chooseFolder);
        }
        if (el.startBtn) {
            el.startBtn.addEventListener("click", startHosting);
        }
        if (el.stopBtn) {
            el.stopBtn.addEventListener("click", stopHosting);
        }
        if (el.copyBtn) {
            el.copyBtn.addEventListener("click", copyLink);
        }
        if (el.openBtn) {
            el.openBtn.addEventListener("click", openLink);
        }
    }

    function init() {
        attachListeners();
        initDragAndDrop();

        setStatus("stopped");
        updateInfo({});
        setBackend("unknown", "Checking backend…");
        initScrollEffects();

        // Ask the backend for the real current state.
        refreshStatus({ silent: false });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();