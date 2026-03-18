// ========== DOM REFS ==========
const btnBatch = document.getElementById("btn-batch");
const btnScrape = document.getElementById("btn-scrape");
const btnStop = document.getElementById("btn-stop");
const btnDownload = document.getElementById("btn-download");
const btnUpload = document.getElementById("btn-upload");
const fileInput = document.getElementById("file-input");
const keywordsEl = document.getElementById("keywords");
const progressDiv = document.querySelector(".progress");
const progressBar = document.getElementById("progress-bar");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const statPosts = document.getElementById("stat-posts");
const statComments = document.getElementById("stat-comments");
const keywordProgressDiv = document.getElementById("keyword-progress");
const keywordProgressText = document.getElementById("keyword-progress-text");
const keywordProgressSub = document.getElementById("keyword-progress-sub");
const modeKeywordsBtn = document.getElementById("mode-keywords");
const modeSubredditsBtn = document.getElementById("mode-subreddits");

// ========== STATE ==========
let shouldStop = false;
let finalData = null;
let currentMode = "keywords"; // "keywords" or "subreddits"

// ========== MODE TOGGLE ==========
function setMode(mode) {
  currentMode = mode;
  chrome.storage.local.set({ scraper_mode: mode });
  const inputTitle = document.getElementById("input-title");
  const inputLabel = document.getElementById("input-label");
  const postCountLabel = document.getElementById("post-count-label");
  const scrapeDivider = document.getElementById("scrape-divider");

  if (mode === "keywords") {
    modeKeywordsBtn.classList.add("active");
    modeSubredditsBtn.classList.remove("active");
    inputTitle.textContent = "Batch Keywords";
    inputLabel.textContent = "One keyword per line:";
    keywordsEl.placeholder = "years of insomnia\nsleep remedies\nchronic insomnia treatment";
    postCountLabel.textContent = "Posts per keyword";
    scrapeDivider.textContent = "— or scrape current search page —";
  } else {
    modeSubredditsBtn.classList.add("active");
    modeKeywordsBtn.classList.remove("active");
    inputTitle.textContent = "Subreddits";
    inputLabel.textContent = "One subreddit per line (with or without r/):";
    keywordsEl.placeholder = "r/Menopause\nr/insomnia\nsleepapnea";
    postCountLabel.textContent = "Posts per subreddit";
    scrapeDivider.textContent = "— or scrape current subreddit page —";
  }
}

modeKeywordsBtn.addEventListener("click", () => setMode("keywords"));
modeSubredditsBtn.addEventListener("click", () => setMode("subreddits"));

// Restore saved mode on load
chrome.storage.local.get("scraper_mode", (result) => {
  if (result.scraper_mode === "subreddits" || result.scraper_mode === "keywords") {
    setMode(result.scraper_mode);
  }
});

// ========== UTILS ==========
function log(msg, type = "") {
  logEl.style.display = "block";
  const entry = document.createElement("div");
  entry.className = "log-entry" + (type ? ` ${type}` : "");
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setProgress(pct) {
  progressBar.style.width = `${pct}%`;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

function getSettings() {
  return {
    postCount: parseInt(document.getElementById("post-count").value) || 100,
    scrollDelay: parseInt(document.getElementById("scroll-delay").value) || 1500,
    fetchDelay: (parseFloat(document.getElementById("fetch-delay").value) || 3) * 1000,
    fetchComments: document.getElementById("fetch-comments").checked,
  };
}

function sendBgMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(`Downloaded: ${filename}`, "success");
}

function showRunningUI() {
  btnBatch.style.display = "none";
  btnScrape.style.display = "none";
  btnStop.style.display = "block";
  btnDownload.style.display = "none";
  progressDiv.style.display = "block";
  setProgress(0);
}

function resetUI() {
  shouldStop = false;
  btnStop.style.display = "none";
  btnBatch.style.display = "block";
  btnScrape.style.display = "block";
  keywordProgressDiv.style.display = "none";
}

// ========== HELPERS: Parse input based on mode ==========
function parseInputItems() {
  const rawText = keywordsEl.value.trim();
  if (!rawText) return [];

  const lines = rawText
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (currentMode === "subreddits") {
    return lines.map((k) => k.replace(/^r\//, ""));
  }
  return lines;
}

function buildUrl(item) {
  if (currentMode === "subreddits") {
    return `https://www.reddit.com/r/${encodeURIComponent(item)}/`;
  }
  return `https://www.reddit.com/search/?q=${encodeURIComponent(item)}`;
}

function itemLabel(item) {
  if (currentMode === "subreddits") {
    return `r/${item}`;
  }
  return `"${item}"`;
}

function modeNoun() {
  return currentMode === "subreddits" ? "subreddit" : "keyword";
}

function modeNounPlural() {
  return currentMode === "subreddits" ? "subreddits" : "keywords";
}

// ========== CORE: Navigate and Wait ==========
async function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

// ========== CORE: Scroll and Collect Posts ==========
function scrollAndCollectPosts(tabId, postCount, scrollDelay, fetchComments) {
  return new Promise(async (resolve, reject) => {
    try {
      // Inject config globals + page type
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (count, delay) => {
          window.__SCRAPER_POST_COUNT = count;
          window.__SCRAPER_SCROLL_DELAY = delay;
        },
        args: [postCount, scrollDelay],
      });

      // Install bridge (new page = fresh context, always re-install)
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          window.__SCRAPER_BRIDGE_INSTALLED = false; // force re-install on new page
          window.addEventListener("message", (e) => {
            if (e.data?.type === "REDDIT_SCRAPER_PROGRESS") {
              chrome.runtime.sendMessage(e.data);
            }
          });
        },
      });

      // Inject content script
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });

      // Listen for progress
      const listener = (msg) => {
        if (msg.type !== "REDDIT_SCRAPER_PROGRESS") return;

        statPosts.textContent = msg.posts.length;
        setStatus(msg.message);

        const pct = Math.min(
          Math.round((msg.posts.length / postCount) * (fetchComments ? 50 : 100)),
          fetchComments ? 50 : 100
        );
        setProgress(pct);

        if (msg.done) {
          chrome.runtime.onMessage.removeListener(listener);
          log(`Scroll done: ${msg.posts.length} posts collected`, "success");
          resolve(msg.posts);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
    } catch (err) {
      reject(err);
    }
  });
}

// ========== CORE: Fetch Comments for Posts ==========
async function fetchCommentsForPosts(posts, fetchDelay) {
  log(`Fetching comments for ${posts.length} posts...`);
  setStatus(`Fetching comments: 0/${posts.length}`);

  const results = [];
  let totalComments = 0;
  let currentDelay = fetchDelay;
  const MIN_DELAY = Math.max(1500, fetchDelay * 0.5);
  const MAX_DELAY = 30000;

  for (let i = 0; i < posts.length; i++) {
    if (shouldStop) {
      log("Stopped by user during comment fetch.", "error");
      break;
    }

    const post = posts[i];
    const pct = 50 + Math.round(((i + 1) / posts.length) * 50);
    setProgress(pct);

    const remaining = posts.length - i;
    const etaSeconds = Math.round((remaining * currentDelay) / 1000);
    const etaMin = Math.floor(etaSeconds / 60);
    const etaSec = etaSeconds % 60;
    const etaStr = etaMin > 0 ? `~${etaMin}m${etaSec}s left` : `~${etaSec}s left`;
    setStatus(`Fetching comments: ${i + 1}/${posts.length} (${etaStr}) — ${post.title.substring(0, 40)}...`);

    const startTime = Date.now();

    try {
      const response = await sendBgMessage({
        type: "FETCH_SINGLE_POST_COMMENTS",
        subreddit: post.subreddit,
        postId: post.postId,
      });

      if (response?.success) {
        const commentData = response.data;
        totalComments += commentData.comments.length;
        results.push({ ...post, ...commentData });
        log(`  [${i + 1}/${posts.length}] ✓ ${commentData.comments.length} comments — "${post.title.substring(0, 50)}"`, "success");
        currentDelay = Math.max(MIN_DELAY, currentDelay * 0.92);
        document.getElementById("stat-delay").textContent = (currentDelay / 1000).toFixed(1) + "s";
      } else {
        const errMsg = response?.error || "Unknown error";
        const isRateLimit = errMsg.toLowerCase().includes("rate limit");
        if (isRateLimit) {
          currentDelay = Math.min(MAX_DELAY, currentDelay * 2);
          log(`  [${i + 1}/${posts.length}] ✗ Rate limited → delay ${(currentDelay / 1000).toFixed(1)}s`, "error");
          document.getElementById("stat-delay").textContent = (currentDelay / 1000).toFixed(1) + "s";
          document.getElementById("stat-delay").style.color = "#ff4500";
        } else {
          log(`  [${i + 1}/${posts.length}] ✗ ${errMsg}`, "error");
        }
        results.push({ ...post, postBody: "", comments: [], error: errMsg });
      }
    } catch (err) {
      log(`  [${i + 1}/${posts.length}] ✗ ${err.message}`, "error");
      currentDelay = Math.min(MAX_DELAY, currentDelay * 1.5);
      results.push({ ...post, postBody: "", comments: [], error: err.message });
    }

    statComments.textContent = totalComments;

    if (i < posts.length - 1 && !shouldStop) {
      const elapsed = Date.now() - startTime;
      const waitTime = Math.max(500, currentDelay - elapsed + Math.random() * 1000);
      await new Promise((r) => setTimeout(r, waitTime));
    }
  }

  return results;
}

// ========== CORE: Scrape a single page (full pipeline) ==========
async function scrapeCurrentPage(tabId, settings) {
  const { postCount, scrollDelay, fetchDelay, fetchComments } = settings;

  // Phase 1: Scroll and collect posts
  const posts = await scrollAndCollectPosts(tabId, postCount, scrollDelay, fetchComments);

  if (shouldStop || posts.length === 0) {
    return posts.map((p) => ({ ...p, postBody: "", comments: [] }));
  }

  // Phase 2: Fetch comments (if enabled)
  if (fetchComments) {
    return await fetchCommentsForPosts(posts, fetchDelay);
  } else {
    return posts.map((p) => ({ ...p, postBody: "", comments: [] }));
  }
}

// ========== BATCH SCRAPE ==========
btnBatch.addEventListener("click", async () => {
  // Snapshot the mode at batch start so it can't change mid-run
  const batchMode = currentMode;
  const items = parseInputItems();
  if (items.length === 0) {
    log(`Please enter at least one ${modeNoun()}!`, "error");
    return;
  }

  // Verify background
  try {
    await sendBgMessage({ type: "PING" });
  } catch (err) {
    log(`Background worker error: ${err.message}`, "error");
    return;
  }

  const settings = getSettings();
  shouldStop = false;
  showRunningUI();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab.id;
  const date = new Date().toISOString().slice(0, 10);

  // Use snapshot mode for all batch helpers
  const batchBuildUrl = (item) => {
    if (batchMode === "subreddits") {
      return `https://www.reddit.com/r/${encodeURIComponent(item)}/`;
    }
    return `https://www.reddit.com/search/?q=${encodeURIComponent(item)}`;
  };
  const batchItemLabel = (item) => batchMode === "subreddits" ? `r/${item}` : `"${item}"`;
  const batchModeNoun = () => batchMode === "subreddits" ? "subreddit" : "keyword";
  const batchModeNounPlural = () => batchMode === "subreddits" ? "subreddits" : "keywords";

  log(`=== BATCH SCRAPE: ${items.length} ${batchModeNounPlural()} (${batchMode} mode) ===`, "keyword");

  for (let ki = 0; ki < items.length; ki++) {
    if (shouldStop) {
      log("Batch stopped by user.", "error");
      break;
    }

    const item = items[ki];
    const targetUrl = batchBuildUrl(item);
    const label = batchItemLabel(item);

    // Update keyword progress
    keywordProgressDiv.style.display = "block";
    keywordProgressText.textContent = `${batchModeNoun()} ${ki + 1}/${items.length}: ${label}`;
    keywordProgressSub.textContent = `Navigating to ${batchMode === "subreddits" ? "subreddit" : "search"}...`;

    log(``, "");
    log(`▸ [${ki + 1}/${items.length}] ${label}`, "keyword");
    log(`  Navigating to: ${targetUrl}`);

    // Reset per-item stats
    statPosts.textContent = "0";
    statComments.textContent = "0";
    document.getElementById("stat-errors").textContent = "0";
    document.getElementById("stat-errors").style.color = "#818384";
    document.getElementById("stat-delay").textContent = "-";
    document.getElementById("stat-delay").style.color = "#818384";
    setProgress(0);

    // Navigate to page
    await navigateAndWait(tabId, targetUrl);

    // Extra wait for Reddit JS to render
    keywordProgressSub.textContent = "Waiting for page to render...";
    await new Promise((r) => setTimeout(r, 2000));

    // Scrape page
    try {
      keywordProgressSub.textContent = "Scrolling & collecting posts...";
      const data = await scrapeCurrentPage(tabId, settings);

      if (data.length > 0) {
        // Auto-download this item's results
        const totalComments = data.reduce((s, p) => s + (p.comments?.length || 0), 0);
        const errorCount = data.filter((p) => p.error).length;
        const filename = `reddit-${slugify(item)}-${date}.json`;
        downloadJSON(data, filename);

        log(`  ✓ Done: ${data.length} posts, ${totalComments} comments, ${errorCount} errors`, "success");

        // Update stats
        statPosts.textContent = data.length;
        statComments.textContent = totalComments;
        document.getElementById("stat-errors").textContent = errorCount;
        document.getElementById("stat-errors").style.color = errorCount > 0 ? "#ff4500" : "#818384";
      } else {
        log(`  ⚠ No posts found for ${label}`, "error");
      }
    } catch (err) {
      log(`  ✗ Error scraping ${label}: ${err.message}`, "error");
    }

    // Brief pause between items
    if (ki < items.length - 1 && !shouldStop) {
      keywordProgressSub.textContent = `Pausing before next ${batchModeNoun()}...`;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Batch complete
  keywordProgressText.textContent = `Batch complete: ${items.length} ${batchModeNounPlural()}`;
  keywordProgressSub.textContent = shouldStop ? "Stopped early by user." : `All ${batchModeNounPlural()} processed.`;
  log(`=== BATCH COMPLETE ===`, "keyword");
  setProgress(100);
  setStatus("Batch complete!");
  resetUI();
});

// ========== SINGLE PAGE SCRAPE ==========
btnScrape.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isSearch = tab?.url?.includes("reddit.com/search");
  const isSubreddit = tab?.url?.match(/reddit\.com\/r\/\w+/);
  if (!isSearch && !isSubreddit) {
    log("Please navigate to a Reddit search page or subreddit first!", "error");
    return;
  }

  try {
    await sendBgMessage({ type: "PING" });
  } catch (err) {
    log(`Background worker error: ${err.message}`, "error");
    return;
  }

  const settings = getSettings();
  shouldStop = false;
  showRunningUI();
  log("Starting single-page scrape...");

  try {
    const data = await scrapeCurrentPage(tab.id, settings);
    finalData = data;

    const totalComments = data.reduce((s, p) => s + (p.comments?.length || 0), 0);
    const errorCount = data.filter((p) => p.error).length;

    statPosts.textContent = data.length;
    statComments.textContent = totalComments;
    document.getElementById("stat-errors").textContent = errorCount;
    document.getElementById("stat-errors").style.color = errorCount > 0 ? "#ff4500" : "#818384";
    setProgress(100);
    setStatus(`Done! ${data.length} posts, ${totalComments} comments${errorCount ? `, ${errorCount} errors` : ""}`);
    log(`Scrape complete: ${data.length} posts, ${totalComments} comments`, "success");

    chrome.runtime.sendMessage({ type: "STORE_DATA", data });
    resetUI();
    btnDownload.style.display = "block";
  } catch (err) {
    log(`Scrape error: ${err.message}`, "error");
    resetUI();
  }
});

// ========== STOP ==========
btnStop.addEventListener("click", () => {
  shouldStop = true;
  setStatus("Stopping...");
  log("Stop requested.", "error");
});

// ========== DOWNLOAD (single-page mode) ==========
btnDownload.addEventListener("click", () => {
  if (!finalData) {
    chrome.runtime.sendMessage({ type: "GET_DATA" }, (response) => {
      if (response?.data) {
        downloadJSON(response.data, `reddit-scrape-${new Date().toISOString().slice(0, 10)}.json`);
      }
    });
    return;
  }
  downloadJSON(finalData, `reddit-scrape-${new Date().toISOString().slice(0, 10)}.json`);
});

// ========== FILE UPLOAD ==========
btnUpload.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    keywordsEl.value = ev.target.result;
    document.getElementById("file-label").textContent = file.name;
    log(`Loaded ${file.name}`, "success");
  };
  reader.readAsText(file);
});

// ========== INIT: Restore previous data ==========
chrome.runtime.sendMessage({ type: "GET_DATA" }, (response) => {
  if (response?.data) {
    finalData = response.data;
    const totalComments = finalData.reduce((s, p) => s + (p.comments?.length || 0), 0);
    statPosts.textContent = finalData.length;
    statComments.textContent = totalComments;
    progressDiv.style.display = "block";
    setProgress(100);
    setStatus(`Previous scrape: ${finalData.length} posts, ${totalComments} comments`);
    btnDownload.style.display = "block";
  }
});
