// Content script injected into Reddit search pages and subreddit pages
// Scrolls the page and collects post data

(async function () {
  const TARGET_COUNT = window.__SCRAPER_POST_COUNT || 100;
  const SCROLL_DELAY = window.__SCRAPER_SCROLL_DELAY || 1500;

  // Detect page type based on URL
  const isSearchPage = window.location.pathname.startsWith("/search");

  // Accumulated posts map (survives DOM virtualization removing elements)
  const collectedPosts = new Map();

  function extractSearchPosts() {
    const containers = document.querySelectorAll(
      '[data-testid="search-post-with-content-preview"]'
    );

    containers.forEach((container) => {
      const titleLink = container.querySelector('a[data-testid="post-title"]');
      if (!titleLink) return;

      const href = titleLink.getAttribute("href");
      if (!href) return;

      const match = href.match(/\/r\/(\w+)\/comments\/(\w+)\//);
      if (!match) return;

      const postId = match[2];
      if (collectedPosts.has(postId)) return;

      const subreddit = match[1];

      const titleTextEl = container.querySelector(
        'a[data-testid="post-title-text"]'
      );
      const title = titleTextEl
        ? titleTextEl.textContent.trim()
        : titleLink.getAttribute("aria-label") || "";

      let snippet = "";
      const allLinks = container.querySelectorAll("a");
      for (const link of allLinks) {
        if (
          !link.hasAttribute("data-testid") &&
          link.classList.contains("line-clamp-2")
        ) {
          snippet = link.textContent.trim();
          break;
        }
      }

      const counterRow = container.querySelector(
        '[data-testid="search-counter-row"]'
      );
      let votes = 0;
      let commentCount = 0;
      if (counterRow) {
        const numbers = counterRow.querySelectorAll("faceplate-number");
        if (numbers.length >= 1)
          votes = parseInt(numbers[0].getAttribute("number")) || 0;
        if (numbers.length >= 2)
          commentCount = parseInt(numbers[1].getAttribute("number")) || 0;
      }

      const timeEl = container.querySelector("faceplate-timeago");
      const timestamp = timeEl ? timeEl.getAttribute("ts") : "";

      collectedPosts.set(postId, {
        postId,
        subreddit,
        title,
        snippet,
        votes,
        commentCount,
        timestamp,
        url: `https://www.reddit.com${href}`,
      });
    });
  }

  function extractSubredditPosts() {
    const postElements = document.querySelectorAll("shreddit-post, article");

    postElements.forEach((el) => {
      let postId, subreddit, title, href;

      if (el.tagName.toLowerCase() === "shreddit-post") {
        postId = el.getAttribute("id");
        if (postId && postId.startsWith("t3_")) {
          postId = postId.substring(3);
        }
        subreddit = el.getAttribute("subreddit-prefixed-name");
        if (subreddit) subreddit = subreddit.replace(/^r\//, "");
        title = el.getAttribute("post-title") || "";
        href = el.getAttribute("content-href") || el.getAttribute("permalink") || "";
      } else {
        const link = el.querySelector('a[data-testid="post-title"], a[slot="title"], a[slot="full-post-link"]');
        if (!link) return;
        href = link.getAttribute("href") || "";
        title = link.textContent.trim() || link.getAttribute("aria-label") || "";
        const match = href.match(/\/r\/(\w+)\/comments\/(\w+)\//);
        if (!match) return;
        subreddit = match[1];
        postId = match[2];
      }

      if (!postId || !subreddit || collectedPosts.has(postId)) return;

      let fullUrl = href;
      if (href && !href.startsWith("http")) {
        fullUrl = `https://www.reddit.com${href}`;
      }

      // Votes
      let votes = 0;
      const scoreAttr = el.getAttribute("score");
      if (scoreAttr) {
        votes = parseInt(scoreAttr) || 0;
      } else {
        const voteEl = el.querySelector('[data-testid="vote-score"], faceplate-number');
        if (voteEl) {
          votes = parseInt(voteEl.getAttribute("number") || voteEl.textContent) || 0;
        }
      }

      // Comment count
      let commentCount = 0;
      const commentAttr = el.getAttribute("comment-count");
      if (commentAttr) {
        commentCount = parseInt(commentAttr) || 0;
      } else {
        const commentEl = el.querySelector('a[data-testid="comments-count"] faceplate-number, [slot="commentCount"]');
        if (commentEl) {
          commentCount = parseInt(commentEl.getAttribute("number") || commentEl.textContent) || 0;
        }
      }

      // Timestamp
      let timestamp = "";
      const timeEl = el.querySelector("faceplate-timeago, time");
      if (timeEl) {
        timestamp = timeEl.getAttribute("ts") || timeEl.getAttribute("datetime") || "";
      } else {
        const createdAttr = el.getAttribute("created-timestamp");
        if (createdAttr) timestamp = createdAttr;
      }

      // Snippet / preview text
      let snippet = "";
      const previewEl = el.querySelector('[slot="text-body"], [data-testid="post-text-body"], .md');
      if (previewEl) {
        snippet = previewEl.textContent.trim().substring(0, 300);
      }

      collectedPosts.set(postId, {
        postId,
        subreddit,
        title,
        snippet,
        votes,
        commentCount,
        timestamp,
        url: fullUrl,
      });
    });
  }

  function scanAndCollect() {
    if (isSearchPage) {
      extractSearchPosts();
    } else {
      extractSubredditPosts();
    }
    return Array.from(collectedPosts.values());
  }

  function sendProgress(posts, done, message) {
    window.postMessage(
      {
        type: "REDDIT_SCRAPER_PROGRESS",
        posts,
        done,
        message,
      },
      "*"
    );
  }

  // Scroll and collect
  let lastCount = 0;
  let staleRounds = 0;
  const MAX_STALE_ROUNDS = 5;

  sendProgress([], false, "Starting scroll collection...");

  while (true) {
    const posts = scanAndCollect();

    if (posts.length >= TARGET_COUNT) {
      const finalPosts = posts.slice(0, TARGET_COUNT);
      sendProgress(
        finalPosts,
        true,
        `Collected ${finalPosts.length} posts. Done!`
      );
      return;
    }

    // Scroll to bottom
    window.scrollTo(0, document.body.scrollHeight);

    sendProgress(
      posts,
      false,
      `Scrolling... found ${posts.length}/${TARGET_COUNT} posts`
    );

    await new Promise((r) => setTimeout(r, SCROLL_DELAY));

    const newPosts = scanAndCollect();
    if (newPosts.length === lastCount) {
      staleRounds++;
      if (staleRounds >= MAX_STALE_ROUNDS) {
        sendProgress(
          newPosts,
          true,
          `No more posts loading. Collected ${newPosts.length} posts total.`
        );
        return;
      }
    } else {
      staleRounds = 0;
    }
    lastCount = newPosts.length;
  }
})();
