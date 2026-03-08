// Content script injected into Reddit search pages
// Scrolls the page and collects post data from search results

(async function () {
  const TARGET_COUNT = window.__SCRAPER_POST_COUNT || 100;
  const SCROLL_DELAY = window.__SCRAPER_SCROLL_DELAY || 1500;

  function extractPosts() {
    const posts = [];
    const seen = new Set();

    // Each search result is wrapped in search-telemetry-tracker with view-events
    const containers = document.querySelectorAll(
      '[data-testid="search-post-with-content-preview"]'
    );

    containers.forEach((container) => {
      const titleLink = container.querySelector('a[data-testid="post-title"]');
      if (!titleLink) return;

      const href = titleLink.getAttribute("href");
      if (!href || seen.has(href)) return;
      seen.add(href);

      // Extract post ID from href like /r/insomnia/comments/kocxjx/...
      const match = href.match(/\/r\/(\w+)\/comments\/(\w+)\//);
      if (!match) return;

      const subreddit = match[1];
      const postId = match[2];

      // Title text
      const titleTextEl = container.querySelector(
        'a[data-testid="post-title-text"]'
      );
      const title = titleTextEl
        ? titleTextEl.textContent.trim()
        : titleLink.getAttribute("aria-label") || "";

      // Snippet text (preview of post body or top comment)
      const snippetTracker = container.querySelector(
        'search-telemetry-tracker[click-events="search/click/post"] + div search-telemetry-tracker a'
      );
      // Fallback: look for the snippet link after the title
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

      // Vote and comment counts from the counter row
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

      // Timestamp
      const timeEl = container.querySelector("faceplate-timeago");
      const timestamp = timeEl ? timeEl.getAttribute("ts") : "";

      posts.push({
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

    return posts;
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
    const posts = extractPosts();

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

    const newPosts = extractPosts();
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
