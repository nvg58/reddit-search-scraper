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

// ========== STATE ==========
let shouldStop = false;
let finalData = null;

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
      // Inject config globals
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

// ========== CORE: Scrape a single search page (full pipeline) ==========
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
  const rawText = keywordsEl.value.trim();
  if (!rawText) {
    log("Please enter at least one keyword!", "error");
    return;
  }

  const keywords = rawText
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (keywords.length === 0) {
    log("No valid keywords found!", "error");
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

  log(`=== BATCH SCRAPE: ${keywords.length} keywords ===`, "keyword");

  for (let ki = 0; ki < keywords.length; ki++) {
    if (shouldStop) {
      log("Batch stopped by user.", "error");
      break;
    }

    const keyword = keywords[ki];
    const searchUrl = `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}`;

    // Update keyword progress
    keywordProgressDiv.style.display = "block";
    keywordProgressText.textContent = `Keyword ${ki + 1}/${keywords.length}: ${keyword}`;
    keywordProgressSub.textContent = `Navigating to search...`;

    log(``, "");
    log(`▸ [${ki + 1}/${keywords.length}] "${keyword}"`, "keyword");
    log(`  Navigating to: ${searchUrl}`);

    // Reset per-keyword stats
    statPosts.textContent = "0";
    statComments.textContent = "0";
    document.getElementById("stat-errors").textContent = "0";
    document.getElementById("stat-errors").style.color = "#818384";
    document.getElementById("stat-delay").textContent = "-";
    document.getElementById("stat-delay").style.color = "#818384";
    setProgress(0);

    // Navigate to search page
    await navigateAndWait(tabId, searchUrl);

    // Extra wait for Reddit JS to render search results
    keywordProgressSub.textContent = "Waiting for page to render...";
    await new Promise((r) => setTimeout(r, 2000));

    // Scrape this keyword's search page
    try {
      keywordProgressSub.textContent = "Scrolling & collecting posts...";
      const data = await scrapeCurrentPage(tabId, settings);

      if (data.length > 0) {
        // Auto-download this keyword's results
        const totalComments = data.reduce((s, p) => s + (p.comments?.length || 0), 0);
        const errorCount = data.filter((p) => p.error).length;
        const filename = `reddit-${slugify(keyword)}-${date}.json`;
        downloadJSON(data, filename);

        log(`  ✓ Done: ${data.length} posts, ${totalComments} comments, ${errorCount} errors`, "success");

        // Update stats
        statPosts.textContent = data.length;
        statComments.textContent = totalComments;
        document.getElementById("stat-errors").textContent = errorCount;
        document.getElementById("stat-errors").style.color = errorCount > 0 ? "#ff4500" : "#818384";
      } else {
        log(`  ⚠ No posts found for "${keyword}"`, "error");
      }
    } catch (err) {
      log(`  ✗ Error scraping "${keyword}": ${err.message}`, "error");
    }

    // Brief pause between keywords
    if (ki < keywords.length - 1 && !shouldStop) {
      keywordProgressSub.textContent = "Pausing before next keyword...";
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Batch complete
  keywordProgressText.textContent = `Batch complete: ${keywords.length} keywords`;
  keywordProgressSub.textContent = shouldStop ? "Stopped early by user." : "All keywords processed.";
  log(`=== BATCH COMPLETE ===`, "keyword");
  setProgress(100);
  setStatus("Batch complete!");
  resetUI();
});

// ========== SINGLE PAGE SCRAPE ==========
btnScrape.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("reddit.com/search")) {
    log("Please navigate to a Reddit search page first!", "error");
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
