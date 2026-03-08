// Background service worker
// Handles fetching comments for each post via Reddit's JSON API

// Open side panel when clicking the extension icon
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Store scrape results
let scrapeData = null;

console.log("[BG] Service worker started");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[BG] Received message:", msg.type);

  if (msg.type === "FETCH_SINGLE_POST_COMMENTS") {
    const { subreddit, postId } = msg;
    console.log(`[BG] Fetching comments for r/${subreddit}/comments/${postId}`);

    fetchPostComments(subreddit, postId)
      .then((commentData) => {
        console.log(`[BG] Success: r/${subreddit}/${postId} - ${commentData.comments.length} comments`);
        sendResponse({ success: true, data: commentData });
      })
      .catch((err) => {
        console.error(`[BG] Error fetching r/${subreddit}/${postId}:`, err);
        sendResponse({ success: false, error: err.message });
      });

    return true; // keep channel open for async response
  }

  if (msg.type === "STORE_DATA") {
    scrapeData = msg.data;
    console.log(`[BG] Stored data: ${msg.data?.length} posts`);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "GET_DATA") {
    console.log(`[BG] Returning stored data: ${scrapeData?.length || 0} posts`);
    sendResponse({ data: scrapeData });
    return false;
  }

  if (msg.type === "PING") {
    sendResponse({ pong: true });
    return false;
  }
});

async function fetchPostComments(subreddit, postId, retryCount = 0) {
  const url = `https://www.reddit.com/r/${subreddit}/comments/${postId}.json?limit=500&depth=100&sort=top&raw_json=1`;
  console.log(`[BG] Fetching URL: ${url}`);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
    });
  } catch (fetchErr) {
    console.error(`[BG] Network error for ${postId}:`, fetchErr.message);
    if (retryCount < 3) {
      const wait = 3000 * (retryCount + 1);
      console.log(`[BG] Retrying (${retryCount + 1}/3) after network error, waiting ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      return fetchPostComments(subreddit, postId, retryCount + 1);
    }
    throw fetchErr;
  }

  console.log(`[BG] Response status: ${response.status} for ${postId}`);

  if (response.status === 429) {
    // Check Retry-After header
    const retryAfter = parseInt(response.headers.get("Retry-After")) || 0;
    const baseWait = retryAfter > 0 ? retryAfter * 1000 : 10000;
    const waitTime = baseWait * (retryCount + 1);
    console.warn(`[BG] Rate limited on ${postId}, Retry-After: ${retryAfter}s, waiting ${waitTime}ms (retry ${retryCount + 1}/5)`);
    if (retryCount < 5) {
      await new Promise((r) => setTimeout(r, waitTime));
      return fetchPostComments(subreddit, postId, retryCount + 1);
    }
    throw new Error(`Rate limited after 5 retries (waited ${waitTime}ms)`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`[BG] HTTP ${response.status} for ${postId}: ${body.substring(0, 200)}`);
    throw new Error(`HTTP ${response.status}`);
  }

  let data;
  try {
    const text = await response.text();
    console.log(`[BG] Response size for ${postId}: ${text.length} chars`);
    data = JSON.parse(text);
  } catch (parseErr) {
    console.error(`[BG] JSON parse error for ${postId}:`, parseErr.message);
    throw new Error(`JSON parse error: ${parseErr.message}`);
  }

  if (!Array.isArray(data) || data.length < 2) {
    console.error(`[BG] Unexpected data shape for ${postId}:`, typeof data, Array.isArray(data) ? data.length : "N/A");
    throw new Error("Unexpected API response shape");
  }

  const postData = data[0]?.data?.children?.[0]?.data || {};
  const commentListing = data[1]?.data?.children || [];

  console.log(`[BG] Post "${postData.title?.substring(0, 40)}..." has ${commentListing.length} top-level comment nodes`);

  const comments = [];
  flattenComments(commentListing, comments, 0);

  console.log(`[BG] Flattened to ${comments.length} total comments for ${postId}`);

  return {
    postBody: postData.selftext || "",
    postScore: postData.score || 0,
    postAuthor: postData.author || "[deleted]",
    postCreatedUtc: postData.created_utc || 0,
    numComments: postData.num_comments || 0,
    comments,
  };
}

function flattenComments(children, result, depth) {
  for (const child of children) {
    if (child.kind !== "t1") {
      // Log "more" comment stubs
      if (child.kind === "more") {
        console.log(`[BG] Skipping 'more' node with ${child.data?.count || 0} additional comments`);
      }
      continue;
    }

    const c = child.data;
    result.push({
      id: c.id,
      author: c.author || "[deleted]",
      body: c.body || "",
      score: c.score || 0,
      createdUtc: c.created_utc || 0,
      depth: depth,
      parentId: c.parent_id || "",
    });

    if (c.replies && c.replies.data && c.replies.data.children) {
      flattenComments(c.replies.data.children, result, depth + 1);
    }
  }
}
