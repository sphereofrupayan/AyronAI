const textInput = document.querySelector("#textInput");
const sendBtn = document.querySelector("#sendBtn");
const voiceBtn = document.querySelector("#btn");
const historyList = document.querySelector("#historyList");
const emptyHistory = document.querySelector("#emptyHistory");
const responseText = document.querySelector("#responseText");
const chatThread = document.querySelector("#chatThread");
const welcomeScreen = document.querySelector("#welcomeScreen");
const specialDateName = document.querySelector("#specialDateName");
const specialDateDay = document.querySelector("#specialDateDay");
const toolsOverlay = document.querySelector("#toolsSection");
const toolModalOverlay = document.querySelector("#toolModalOverlay");
const toolModalTitle = document.querySelector("#toolModalTitle");
const toolModalBody = document.querySelector("#toolModalBody");
const toolModalClose = document.querySelector("#toolModalClose");
const toolsGrid = document.querySelector("#toolsGrid");
const moduleSearchInput = document.querySelector("#moduleSearchInput");
const moduleCount = document.querySelector("#moduleCount");
const modulesEmpty = document.querySelector("#modulesEmpty");
const composerAddBtn = document.querySelector("#composerAddBtn");
const composerToolsMenu = document.querySelector("#composerToolsMenu");
const thinkMenuOption = document.querySelector("#thinkMenuOption");

let conversationHistory = [];
let userLocation = { lat: null, lon: null };
let isSending = false;
let toastTimeout;
let activeModuleCategory = "all";
let activeUserId = null;

function getHistoryStorageKey() {
    const userId = window.rushoAuth?.getUserId();
    return userId ? `rushoBotHistory:${userId}` : null;
}

function getHistory() {
    const storageKey = getHistoryStorageKey();
    if (!storageKey) return [];
    try {
        const history = JSON.parse(localStorage.getItem(storageKey) || "[]");
        return Array.isArray(history) ? history.filter(item => typeof item === "string") : [];
    } catch (error) {
        console.error("Could not read recent conversations:", error);
        return [];
    }
}

function saveHistory(items) {
    const storageKey = getHistoryStorageKey();
    if (!storageKey) return;
    try {
        localStorage.setItem(storageKey, JSON.stringify(items.slice(0, 30)));
    } catch (error) {
        console.error("Could not save recent conversations:", error);
        showToast("Could not save this conversation to recents.");
    }
}

function renderHistory(filter = "") {
    const items = getHistory().filter(item => item.toLowerCase().includes(filter.toLowerCase()));
    historyList.replaceChildren();
    emptyHistory.hidden = items.length > 0;
    emptyHistory.textContent = filter ? "No matching conversations." : "Your conversations will appear here.";

    items.forEach(item => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.className = "history-item";
        button.type = "button";
        button.title = item;
        const label = document.createElement("span");
        label.textContent = item;
        button.appendChild(label);
        button.addEventListener("click", () => {
            startNewChat();
            textInput.value = item;
            sendMessage();
            document.querySelector(".sidebar")?.classList.remove("mobile-open");
        });
        li.appendChild(button);
        historyList.appendChild(li);
    });
}

function addToHistory(message) {
    if (!message.trim()) return;
    const items = getHistory().filter(item => item !== message);
    items.unshift(message);
    saveHistory(items);
    renderHistory(document.querySelector("#historySearchInput").value);
}

function showToast(message) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

async function loadSpecialDate() {
    try {
        const response = await fetch("/api/special-date");
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || "Could not load special dates.");
        }

        if (!data.holiday) {
            specialDateName.textContent = "No upcoming holidays found this year";
            specialDateDay.textContent = "";
            return;
        }

        const holidayNames = data.holiday.names;
        if (!Array.isArray(holidayNames) || holidayNames.length === 0) {
            throw new Error("The special-date response did not include a holiday name.");
        }

        const diwali = holidayNames.find(name => /diwali|deepavali/i.test(name));
        const christmas = holidayNames.find(name => /christmas/i.test(name));
        const newYear = holidayNames.find(name => /new year's day/i.test(name));
        const holidayName = diwali
            ? "Diwali"
            : christmas
                ? "Christmas"
                : newYear
                    ? "New Year"
                    : holidayNames[0].split(/[/(]/, 1)[0].trim();
        specialDateName.textContent = christmas && !diwali
            ? "Merry Christmas!"
            : `Happy ${holidayName}!`;

        const holidayDate = new Date(`${data.holiday.date}T00:00:00`);
        specialDateDay.dateTime = data.holiday.date;
        specialDateDay.textContent = new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric"
        }).format(holidayDate);
    } catch (error) {
        console.error("Could not load special dates:", error);
        specialDateName.textContent = "Special dates are unavailable right now";
        specialDateDay.textContent = "";
    }
}

function appendInlineMarkdown(parent, text) {
    const tokenPattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|(https?:\/\/[^\s<]+)/g;
    let lastIndex = 0;
    let match;

    while ((match = tokenPattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        if (match[1]) {
            const link = createMarkdownLink(match[1], match[2]);
            if (link) parent.appendChild(link);
            else parent.appendChild(document.createTextNode(match[0]));
        } else if (match[3]) {
            const code = document.createElement("code");
            code.textContent = match[3];
            parent.appendChild(code);
        } else if (match[4] || match[5]) {
            const strong = document.createElement("strong");
            appendInlineMarkdown(strong, match[4] || match[5]);
            parent.appendChild(strong);
        } else if (match[6] || match[7]) {
            const emphasis = document.createElement("em");
            appendInlineMarkdown(emphasis, match[6] || match[7]);
            parent.appendChild(emphasis);
        } else {
            const rawUrl = match[8];
            const url = rawUrl.replace(/[.,!?;:]+$/, "");
            const link = createMarkdownLink(url, url);
            if (link) {
                parent.appendChild(link);
                parent.appendChild(document.createTextNode(rawUrl.slice(url.length)));
            } else {
                parent.appendChild(document.createTextNode(rawUrl));
            }
        }

        lastIndex = tokenPattern.lastIndex;
    }

    if (lastIndex < text.length) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
}

function createMarkdownLink(label, href) {
    let url;
    try {
        url = new URL(href);
    } catch (error) {
        return null;
    }
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;

    const link = document.createElement("a");
    link.href = url.href;
    link.textContent = label;
    if (url.protocol !== "mailto:") {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
    }
    return link;
}

function renderAssistantMarkdown(container, text) {
    container.replaceChildren();
    const lines = text.split(/\r?\n/);
    let paragraphLines = [];
    let list = null;
    let listType = null;

    const flushParagraph = () => {
        if (!paragraphLines.length) return;
        const paragraph = document.createElement("p");
        appendInlineMarkdown(paragraph, paragraphLines.join(" "));
        container.appendChild(paragraph);
        paragraphLines = [];
    };
    const flushList = () => {
        if (!list) return;
        container.appendChild(list);
        list = null;
        listType = null;
    };

    lines.forEach(line => {
        const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
        const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
        const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);

        if (!line.trim()) {
            flushParagraph();
            flushList();
        } else if (heading) {
            flushParagraph();
            flushList();
            const headingElement = document.createElement(`h${heading[1].length}`);
            appendInlineMarkdown(headingElement, heading[2]);
            container.appendChild(headingElement);
        } else if (bullet || numbered) {
            flushParagraph();
            const nextListType = bullet ? "ul" : "ol";
            if (listType !== nextListType) flushList();
            if (!list) {
                list = document.createElement(nextListType);
                listType = nextListType;
                if (numbered && Number(numbered[1]) !== 1) {
                    list.start = Number(numbered[1]);
                }
            }
            const item = document.createElement("li");
            appendInlineMarkdown(item, (bullet || numbered)[bullet ? 1 : 2]);
            list.appendChild(item);
        } else {
            flushList();
            paragraphLines.push(line.trim());
        }
    });

    flushParagraph();
    flushList();
}

function appendMessage(role, text, pending = false) {
    welcomeScreen.classList.add("hidden");
    chatThread.classList.add("active");

    const message = document.createElement("article");
    message.className = `message ${role}`;
    if (role === "assistant") {
        const mark = document.createElement("span");
        mark.className = "assistant-mark";
        mark.textContent = "A";
        mark.setAttribute("aria-hidden", "true");
        message.appendChild(mark);
    }

    const content = document.createElement("div");
    content.className = "message-bubble";
    if (pending) {
        content.classList.add("message-status");
        content.textContent = text;
    } else {
        content.textContent = text;
    }
    message.appendChild(content);
    chatThread.appendChild(message);
    chatThread.scrollTop = chatThread.scrollHeight;
    return { message, content };
}

function startNewChat() {
    conversationHistory = [];
    chatThread.replaceChildren();
    chatThread.classList.remove("active");
    welcomeScreen.classList.remove("hidden");
    responseText.textContent = "";
    textInput.value = "";
    resizeInput();
    textInput.focus();
}

function resizeInput() {
    textInput.style.height = "auto";
    textInput.style.height = `${Math.min(textInput.scrollHeight, 180)}px`;
}

async function authenticatedFetch(url, options = {}) {
    if (!window.rushoAuth?.getIdToken) {
        throw new Error("Secure sign-in is still loading. Please try again.");
    }
    const token = await window.rushoAuth.getIdToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...options, headers });
}

async function getLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        position => {
            userLocation = {
                lat: position.coords.latitude,
                lon: position.coords.longitude
            };
        },
        () => {},
        { timeout: 5000 }
    );
}

async function requestAssistant(message) {
    const isCricketRequest = /\b(cricket score|match score|live score|score update|current score)\b/i.test(message);
    const endpoint = isCricketRequest ? "/cricket-score" : "/chat";
    const payload = isCricketRequest
        ? { message }
        : {
            message,
            history: conversationHistory.slice(0, -1),
            lat: userLocation.lat,
            lon: userLocation.lon,
            think: document.querySelector("#thinkBtn").getAttribute("aria-pressed") === "true"
        };
    const response = await authenticatedFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (!response.ok || data.error) {
        throw new Error(data.error || "The assistant could not answer right now.");
    }
    return data.reply;
}

async function sendMessage(messageOverride) {
    const message = (messageOverride || textInput.value).trim();
    if (!message || isSending) return;

    isSending = true;
    sendBtn.disabled = true;
    textInput.value = "";
    resizeInput();
    addToHistory(message);
    appendMessage("user", message);
    conversationHistory.push({ role: "user", content: message });
    const pending = appendMessage("assistant", "Thinking...", true);

    try {
        const reply = await requestAssistant(message);
        pending.content.classList.remove("message-status");
        const formattedReply = reply || "I couldn't generate a response. Please try again.";
        renderAssistantMarkdown(pending.content, formattedReply);
        responseText.textContent = reply || "";
        conversationHistory.push({ role: "assistant", content: reply || "" });
        if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);
    } catch (error) {
        console.error("Assistant request failed:", error);
        pending.content.classList.remove("message-status");
        pending.content.textContent = `Sorry, I couldn't get a response. ${error.message}`;
        responseText.textContent = pending.content.textContent;
    } finally {
        isSending = false;
        sendBtn.disabled = false;
        textInput.focus();
        chatThread.scrollTop = chatThread.scrollHeight;
    }
}

const speechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
if (speechRecognition) {
    recognition = new speechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onresult = event => {
        const transcript = event.results[event.resultIndex][0].transcript.trim();
        textInput.value = transcript;
        resizeInput();
        sendMessage(transcript);
    };
    recognition.onerror = event => {
        console.error("Voice input failed:", event.error);
        showToast(event.error === "not-allowed" ? "Allow microphone access to use voice input." : "Voice input could not start.");
    };
    recognition.onend = () => voiceBtn.classList.remove("listening");
} else {
    voiceBtn.disabled = true;
    voiceBtn.title = "Voice input is not supported in this browser";
    voiceBtn.setAttribute("aria-label", "Voice input is not supported in this browser");
}

function openTools() {
    toolsOverlay.classList.add("active");
    toolsOverlay.setAttribute("aria-hidden", "false");
    document.querySelector("#closeToolsBtn").focus();
    filterModules();
}

function closeTools() {
    toolsOverlay.classList.remove("active");
    toolsOverlay.setAttribute("aria-hidden", "true");
    document.querySelector("#openToolsBtn").focus();
}

function closeComposerTools(restoreFocus = false) {
    composerToolsMenu.hidden = true;
    composerAddBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus) composerAddBtn.focus();
}

function toggleThinkMode() {
    const enabled = document.querySelector("#thinkBtn").getAttribute("aria-pressed") !== "true";
    document.querySelector("#thinkBtn").setAttribute("aria-pressed", String(enabled));
    thinkMenuOption.setAttribute("aria-checked", String(enabled));
    showToast(enabled ? "Thoughtful response mode enabled." : "Thoughtful response mode disabled.");
}

function filterModules() {
    const query = moduleSearchInput.value.trim().toLowerCase();
    const cards = [...toolsGrid.querySelectorAll(".tool-card")];
    let visibleCount = 0;
    cards.forEach(card => {
        const categories = card.dataset.category.split(" ");
        const matchesCategory = activeModuleCategory === "all" || categories.includes(activeModuleCategory);
        const matchesSearch = `${card.textContent} ${card.dataset.search}`.toLowerCase().includes(query);
        const visible = matchesCategory && matchesSearch;
        card.hidden = !visible;
        if (visible) visibleCount += 1;
    });
    moduleCount.textContent = String(visibleCount);
    modulesEmpty.hidden = visibleCount > 0;
}

const toolConfig = {
    resume: {
        title: "Resume Analyzer",
        fields: [{ type: "file", name: "file", label: "Upload your resume (PDF)", accept: ".pdf" }],
        endpoint: "/resume-analyze",
        submitLabel: "Analyze Resume",
        isFormData: true
    },
    notes: {
        title: "Notes Summarizer",
        fields: [{ type: "textarea", name: "text", label: "Paste your notes", placeholder: "Paste the notes you want summarized...", rows: 8 }],
        endpoint: "/notes-summarize",
        submitLabel: "Summarize Notes"
    },
    code: {
        title: "Code Reviewer",
        fields: [
            { type: "text", name: "language", label: "Language (optional)", placeholder: "e.g. Python, JavaScript" },
            { type: "textarea", name: "code", label: "Paste your code", placeholder: "Paste the code you want reviewed...", rows: 10 }
        ],
        endpoint: "/code-review",
        submitLabel: "Review Code"
    },
    email: {
        title: "Email Writer",
        fields: [
            { type: "select", name: "tone", label: "Tone", options: ["Professional", "Friendly", "Formal", "Persuasive"] },
            { type: "textarea", name: "details", label: "What should the email say?", placeholder: "e.g. Ask my manager for two days of leave next week...", rows: 6 }
        ],
        endpoint: "/email-write",
        submitLabel: "Generate Email"
    },
    planner: {
        title: "Study Planner",
        fields: [
            { type: "text", name: "subject", label: "Subject / Exam", placeholder: "e.g. Oracle SQL fundamentals" },
            { type: "text", name: "duration", label: "Timeframe", placeholder: "e.g. 2 weeks, 5 days" },
            { type: "textarea", name: "goal", label: "Goal (optional)", placeholder: "e.g. Pass the certification exam", rows: 4 }
        ],
        endpoint: "/study-planner",
        submitLabel: "Create Plan"
    },
    quiz: {
        title: "Quiz Generator",
        fields: [
            { type: "text", name: "topic", label: "Topic", placeholder: "e.g. Oracle multitenant architecture" },
            { type: "select", name: "difficulty", label: "Difficulty", options: ["Easy", "Medium", "Hard"] },
            { type: "select", name: "count", label: "Number of questions", options: ["3", "5", "10"] }
        ],
        endpoint: "/quiz-generate",
        submitLabel: "Generate Quiz",
        isQuiz: true
    },
    pdf: { title: "PDF Chat", isPdfChat: true },
    translator: {
        title: "Translator",
        fields: [
            { type: "text", name: "target_language", label: "Translate to", placeholder: "e.g. French, Hindi, Spanish" },
            { type: "textarea", name: "text", label: "Text to translate", placeholder: "Paste the text you want translated...", rows: 6 }
        ],
        endpoint: "/translate",
        submitLabel: "Translate"
    },
    grammar: {
        title: "Grammar Checker",
        fields: [{ type: "textarea", name: "text", label: "Paste your text", placeholder: "Paste the text you want checked...", rows: 6 }],
        endpoint: "/grammar-check",
        submitLabel: "Check Grammar"
    }
};

function buildToolField(field) {
    const wrapper = document.createElement("div");
    wrapper.className = "tool-field";
    const label = document.createElement("label");
    label.textContent = field.label;
    wrapper.appendChild(label);

    let input;
    if (field.type === "textarea") {
        input = document.createElement("textarea");
        input.rows = field.rows || 5;
        input.placeholder = field.placeholder || "";
    } else if (field.type === "select") {
        input = document.createElement("select");
        field.options.forEach(value => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            input.appendChild(option);
        });
    } else {
        input = document.createElement("input");
        input.type = field.type === "file" ? "file" : "text";
        input.placeholder = field.placeholder || "";
        input.accept = field.accept || "";
    }
    input.dataset.fieldName = field.name;
    label.htmlFor = `field-${field.name}`;
    input.id = `field-${field.name}`;
    wrapper.appendChild(input);
    return wrapper;
}

function openToolModal(key) {
    if (key === "chat") {
        closeTools();
        textInput.focus();
        return;
    }

    if (["web", "research", "image", "sketch"].includes(key)) {
        closeTools();
        toolModalTitle.textContent = {
            web: "Web search",
            research: "Deep research",
            image: "Create image",
            sketch: "Sketch"
        }[key];
        toolModalBody.replaceChildren();
        toolModalOverlay.classList.add("active");
        toolModalOverlay.setAttribute("aria-hidden", "false");
        if (key === "sketch") buildSketchTool();
        else buildConnectedTool(key);
        return;
    }

    const config = toolConfig[key];
    if (!config) return;
    closeTools();
    toolModalTitle.textContent = config.title;
    toolModalBody.replaceChildren();
    toolModalOverlay.classList.add("active");
    toolModalOverlay.setAttribute("aria-hidden", "false");

    if (config.isPdfChat) {
        buildPdfChatModal();
        return;
    }

    const form = document.createElement("div");
    config.fields.forEach(field => form.appendChild(buildToolField(field)));
    const submit = document.createElement("button");
    submit.className = "tool-submit-btn";
    submit.type = "button";
    submit.textContent = config.submitLabel;
    const result = document.createElement("div");
    toolModalBody.append(form, submit, result);

    submit.addEventListener("click", async () => {
        const fields = config.fields.map(field => ({
            ...field,
            element: form.querySelector(`[data-field-name="${field.name}"]`)
        }));
        const missing = fields.find(field => field.type === "file" ? !field.element.files[0] : !field.element.value.trim() && field.name !== "goal" && field.name !== "language");
        if (missing) {
            result.className = "tool-error";
            result.textContent = `Please provide ${missing.label.toLowerCase()}.`;
            return;
        }

        result.className = "";
        result.textContent = "";
        submit.disabled = true;
        submit.textContent = "Working...";
        try {
            let response;
            if (config.isFormData) {
                const formData = new FormData();
                fields.forEach(field => {
                    if (field.type === "file") formData.append(field.name, field.element.files[0]);
                    else formData.append(field.name, field.element.value);
                });
                response = await authenticatedFetch(config.endpoint, { method: "POST", body: formData });
            } else {
                const payload = Object.fromEntries(fields.map(field => [field.name, field.element.value]));
                response = await authenticatedFetch(config.endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
            }
            const data = await response.json();
            if (!response.ok || data.error) {
                result.className = "tool-error";
                result.textContent = data.error || "Something went wrong.";
            } else if (config.isQuiz) {
                renderQuiz(result, data.questions || []);
            } else {
                result.className = "tool-result";
                result.textContent = data.reply || "No response was returned.";
            }
        } catch (error) {
            console.error(`${config.title} request failed:`, error);
            result.className = "tool-error";
            result.textContent = "Could not reach the server. Please try again.";
        } finally {
            submit.disabled = false;
            submit.textContent = config.submitLabel;
        }
    });
}

function addToolField(labelText, placeholder, type = "text") {
    const wrapper = document.createElement("div");
    wrapper.className = "tool-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
    if (type !== "textarea") input.type = type;
    input.placeholder = placeholder;
    input.maxLength = type === "textarea" ? 1000 : 500;
    wrapper.append(label, input);
    return { wrapper, input };
}

function renderSearchResults(container, results) {
    container.replaceChildren();
    container.className = "tool-result search-results";
    if (!results.length) {
        container.textContent = "No results found. Try a different query.";
        return;
    }

    results.forEach(result => {
        const item = document.createElement("article");
        item.className = "search-result";
        const link = document.createElement("a");
        link.href = result.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = result.title || result.url;
        const excerpt = document.createElement("p");
        excerpt.textContent = result.content || "";
        item.append(link, excerpt);
        container.appendChild(item);
    });
}

function buildConnectedTool(key) {
    const isImage = key === "image";
    const { wrapper, input } = addToolField(
        isImage ? "Describe the image you want" : key === "research" ? "Research question" : "Search the web",
        isImage ? "A watercolor illustration of a quiet mountain village at sunrise..." : "What would you like to find out?",
        isImage ? "textarea" : "text"
    );
    if (isImage) input.rows = 3;
    const submit = document.createElement("button");
    submit.className = "tool-submit-btn";
    submit.type = "button";
    submit.textContent = isImage ? "Generate image" : key === "research" ? "Start research" : "Search";
    const result = document.createElement("div");
    toolModalBody.append(wrapper, submit, result);

    submit.addEventListener("click", async () => {
        const query = input.value.trim();
        if (!query) {
            result.className = "tool-error";
            result.textContent = isImage ? "Describe the image first." : "Enter a query first.";
            return;
        }

        submit.disabled = true;
        submit.textContent = isImage ? "Generating..." : key === "research" ? "Researching..." : "Searching...";
        result.className = "tool-result";
        result.textContent = isImage ? "Creating your image. This can take a little while..." : "Searching trusted sources...";
        try {
            const response = await authenticatedFetch(
                isImage ? "/api/generate-image" : key === "research" ? "/api/deep-research" : "/api/web-search",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(isImage ? { prompt: query } : { query })
                }
            );
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error || "The request could not be completed.");

            if (isImage) {
                result.replaceChildren();
                result.className = "tool-result generated-image-result";
                const image = document.createElement("img");
                image.src = data.image;
                image.alt = query;
                const download = document.createElement("a");
                download.href = data.image;
                download.download = "ayron-generated-image.jpg";
                download.textContent = "Download image";
                result.append(image, download);
            } else if (key === "research") {
                result.replaceChildren();
                result.className = "tool-result research-result";
                const report = document.createElement("div");
                renderAssistantMarkdown(report, data.report || "No report was returned.");
                const sourceHeading = document.createElement("h4");
                sourceHeading.textContent = "Sources";
                const sources = document.createElement("div");
                result.append(report, sourceHeading, sources);
                renderSearchResults(sources, data.sources || []);
            } else {
                renderSearchResults(result, data.results || []);
            }
        } catch (error) {
            console.error(`${key} request failed:`, error);
            result.className = "tool-error";
            result.textContent = error.message || "Could not reach the server. Please try again.";
        } finally {
            submit.disabled = false;
            submit.textContent = isImage ? "Generate image" : key === "research" ? "Start research" : "Search";
        }
    });
}

function buildSketchTool() {
    const instructions = document.createElement("p");
    instructions.className = "sketch-instructions";
    instructions.textContent = "Draw with your mouse, touch, or pen, then download your sketch as a PNG.";
    const canvas = document.createElement("canvas");
    canvas.className = "sketch-canvas";
    canvas.width = 1000;
    canvas.height = 600;
    canvas.setAttribute("aria-label", "Sketch drawing area");
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#171717";
    context.lineWidth = 5;
    context.lineCap = "round";
    context.lineJoin = "round";
    let drawing = false;

    const getPoint = event => {
        const bounds = canvas.getBoundingClientRect();
        return {
            x: (event.clientX - bounds.left) * canvas.width / bounds.width,
            y: (event.clientY - bounds.top) * canvas.height / bounds.height
        };
    };
    canvas.addEventListener("pointerdown", event => {
        drawing = true;
        canvas.setPointerCapture(event.pointerId);
        const point = getPoint(event);
        context.beginPath();
        context.moveTo(point.x, point.y);
    });
    canvas.addEventListener("pointermove", event => {
        if (!drawing) return;
        const point = getPoint(event);
        context.lineTo(point.x, point.y);
        context.stroke();
    });
    canvas.addEventListener("pointerup", () => { drawing = false; });
    canvas.addEventListener("pointercancel", () => { drawing = false; });

    const actions = document.createElement("div");
    actions.className = "sketch-actions";
    const clear = document.createElement("button");
    clear.className = "tool-submit-btn sketch-secondary";
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
    });
    const download = document.createElement("a");
    download.className = "tool-submit-btn sketch-download";
    download.href = canvas.toDataURL("image/png");
    download.download = "ayron-sketch.png";
    download.textContent = "Download sketch";
    download.addEventListener("click", () => {
        download.href = canvas.toDataURL("image/png");
    });
    actions.append(clear, download);
    toolModalBody.append(instructions, canvas, actions);
}

function renderQuiz(container, questions) {
    container.replaceChildren();
    container.className = "";
    if (!questions.length) {
        container.className = "tool-error";
        container.textContent = "No questions were generated. Try again.";
        return;
    }
    questions.forEach((question, index) => {
        const wrap = document.createElement("div");
        wrap.className = "quiz-question";
        const title = document.createElement("p");
        title.className = "q-text";
        title.textContent = `${index + 1}. ${question.question}`;
        wrap.appendChild(title);
        (question.options || []).forEach(option => {
            const button = document.createElement("button");
            button.className = "quiz-option";
            button.type = "button";
            button.textContent = option;
            button.addEventListener("click", () => {
                const buttons = wrap.querySelectorAll(".quiz-option");
                buttons.forEach(item => { item.disabled = true; });
                if (option === question.answer) button.classList.add("correct");
                else {
                    button.classList.add("incorrect");
                    buttons.forEach(item => {
                        if (item.textContent === question.answer) item.classList.add("correct");
                    });
                }
            });
            wrap.appendChild(button);
        });
        container.appendChild(wrap);
    });
}

function buildPdfChatModal() {
    let pdfContext = "";
    const uploadWrap = document.createElement("div");
    uploadWrap.className = "tool-field";
    const label = document.createElement("label");
    label.textContent = "Upload a PDF to chat with";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".pdf";
    uploadWrap.append(label, fileInput);
    const uploadButton = document.createElement("button");
    uploadButton.className = "tool-submit-btn";
    uploadButton.type = "button";
    uploadButton.textContent = "Upload PDF";
    const status = document.createElement("div");
    const questionWrap = document.createElement("div");
    questionWrap.className = "tool-field";
    questionWrap.hidden = true;
    const questionLabel = document.createElement("label");
    questionLabel.textContent = "Ask a question about the document";
    const questionInput = document.createElement("input");
    questionInput.type = "text";
    questionInput.placeholder = "e.g. Summarize section 2";
    questionWrap.append(questionLabel, questionInput);
    const askButton = document.createElement("button");
    askButton.className = "tool-submit-btn";
    askButton.type = "button";
    askButton.textContent = "Ask";
    askButton.hidden = true;
    const answer = document.createElement("div");
    toolModalBody.append(uploadWrap, uploadButton, status, questionWrap, askButton, answer);

    uploadButton.addEventListener("click", async () => {
        if (!fileInput.files[0]) {
            status.className = "tool-error";
            status.textContent = "Choose a PDF file first.";
            return;
        }
        uploadButton.disabled = true;
        uploadButton.textContent = "Uploading...";
        status.className = "tool-result";
        status.textContent = "Reading PDF...";
        try {
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            const response = await authenticatedFetch("/pdf-upload", { method: "POST", body: formData });
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error || "Could not read the PDF.");
            pdfContext = data.text;
            status.textContent = "PDF loaded. Ask a question below.";
            questionWrap.hidden = false;
            askButton.hidden = false;
        } catch (error) {
            status.className = "tool-error";
            status.textContent = error.message || "Could not reach the server.";
        } finally {
            uploadButton.disabled = false;
            uploadButton.textContent = "Upload PDF";
        }
    });

    askButton.addEventListener("click", async () => {
        const question = questionInput.value.trim();
        if (!question || !pdfContext) {
            answer.className = "tool-error";
            answer.textContent = "Enter a question about the uploaded PDF.";
            return;
        }
        askButton.disabled = true;
        askButton.textContent = "Thinking...";
        answer.className = "tool-result";
        answer.textContent = "Thinking...";
        try {
            const response = await authenticatedFetch("/pdf-chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ context: pdfContext, question })
            });
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error || "Something went wrong.");
            answer.textContent = data.reply || "No response was returned.";
        } catch (error) {
            answer.className = "tool-error";
            answer.textContent = error.message || "Could not reach the server.";
        } finally {
            askButton.disabled = false;
            askButton.textContent = "Ask";
        }
    });
}

function closeToolModal(returnToModules = true) {
    toolModalOverlay.classList.remove("active");
    toolModalOverlay.setAttribute("aria-hidden", "true");
    toolModalBody.replaceChildren();
    if (returnToModules) openTools();
}

document.querySelector("#newChatBtn").addEventListener("click", () => {
    startNewChat();
    document.querySelector(".sidebar").classList.remove("mobile-open");
});
document.querySelector("#openToolsBtn").addEventListener("click", openTools);
composerAddBtn.addEventListener("click", () => {
    composerToolsMenu.hidden = !composerToolsMenu.hidden;
    composerAddBtn.setAttribute("aria-expanded", String(!composerToolsMenu.hidden));
    if (!composerToolsMenu.hidden) composerToolsMenu.querySelector('[role="menuitem"]').focus();
});
composerToolsMenu.addEventListener("click", event => {
    const option = event.target.closest("[data-composer-action]");
    if (!option) return;

    const action = option.dataset.composerAction;
    closeComposerTools(true);
    if (["pdf", "image", "web", "research", "sketch"].includes(action)) {
        openToolModal(action);
    } else if (action === "library") {
        openTools();
    } else if (action === "think") {
        toggleThinkMode();
    } else {
        const destinations = {
            github: "https://github.com/login",
            platform: "https://platform.openai.com/api-keys",
            gmail: "https://mail.google.com/"
        };
        const destination = destinations[action];
        if (destination) window.open(destination, "_blank", "noopener,noreferrer");
    }
});
composerToolsMenu.addEventListener("keydown", event => {
    const options = [...composerToolsMenu.querySelectorAll('[role^="menuitem"]')];
    const index = options.indexOf(document.activeElement);
    let nextIndex;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % options.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + options.length) % options.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex !== undefined) {
        event.preventDefault();
        options[nextIndex].focus();
    }
});
document.addEventListener("click", event => {
    if (!composerToolsMenu.hidden && !composerToolsMenu.contains(event.target) && !composerAddBtn.contains(event.target)) {
        closeComposerTools();
    }
});
document.querySelector("#closeToolsBtn").addEventListener("click", closeTools);
toolsGrid.querySelectorAll(".tool-card").forEach(card => {
    card.addEventListener("click", () => openToolModal(card.dataset.tool));
});
document.querySelectorAll(".module-filter").forEach(button => {
    button.addEventListener("click", () => {
        activeModuleCategory = button.dataset.category;
        document.querySelectorAll(".module-filter").forEach(filter => {
            const active = filter === button;
            filter.classList.toggle("active", active);
            filter.setAttribute("aria-pressed", String(active));
        });
        filterModules();
    });
});
moduleSearchInput.addEventListener("input", filterModules);
toolModalClose.addEventListener("click", closeToolModal);
toolModalOverlay.addEventListener("click", event => {
    if (event.target === toolModalOverlay) closeToolModal();
});
sendBtn.addEventListener("click", () => sendMessage());
textInput.addEventListener("input", resizeInput);
textInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
});
voiceBtn.addEventListener("click", () => {
    if (!recognition) return;
    try {
        recognition.start();
        voiceBtn.classList.add("listening");
    } catch (error) {
        console.error("Could not start voice input:", error);
        showToast("Voice input is already listening.");
    }
});
document.querySelectorAll(".suggestion").forEach(button => {
    button.addEventListener("click", () => {
        textInput.value = button.dataset.prompt;
        sendMessage();
    });
});
document.querySelector("#clearHistoryBtn").addEventListener("click", () => {
    const storageKey = getHistoryStorageKey();
    if (storageKey) localStorage.removeItem(storageKey);
    renderHistory();
});
document.querySelector("#searchHistoryBtn").addEventListener("click", () => {
    const wrap = document.querySelector("#historySearchWrap");
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) document.querySelector("#historySearchInput").focus();
    else renderHistory();
});
document.querySelector("#historySearchInput").addEventListener("input", event => renderHistory(event.target.value));
document.querySelector("#sidebarCollapseBtn").addEventListener("click", () => {
    if (window.innerWidth <= 700) document.querySelector(".sidebar").classList.remove("mobile-open");
    else document.body.classList.toggle("sidebar-collapsed");
});
document.querySelector("#mobileMenuBtn").addEventListener("click", () => {
    if (window.innerWidth <= 700) {
        document.querySelector(".sidebar").classList.toggle("mobile-open");
    } else {
        document.body.classList.remove("sidebar-collapsed");
    }
});
document.querySelector("#upgradeBtn").addEventListener("click", () => showToast("Upgrade options are not available yet."));
document.querySelector("#topUpgradeBtn").addEventListener("click", () => showToast("Upgrade options are not available yet."));
document.querySelector("#thinkBtn").addEventListener("click", event => {
    toggleThinkMode();
});
document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
        if (!composerToolsMenu.hidden) {
            closeComposerTools(true);
        } else if (toolModalOverlay.classList.contains("active")) {
            closeToolModal();
        } else if (toolsOverlay.classList.contains("active")) {
            closeTools();
        } else {
            document.querySelector(".sidebar").classList.remove("mobile-open");
        }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (toolModalOverlay.classList.contains("active")) closeToolModal(false);
        startNewChat();
        closeTools();
    }
    if (event.key === "/" && !toolsOverlay.classList.contains("active") &&
        !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        event.preventDefault();
        openTools();
        moduleSearchInput.focus();
    }
});

window.addEventListener("rusho-auth-state-changed", event => {
    const userId = event.detail.userId;
    if (userId !== activeUserId) {
        activeUserId = userId;
        startNewChat();
    }
    renderHistory();
});

renderHistory();
filterModules();
getLocation();
loadSpecialDate();
