const USER_ID = "34671307055793656";
const ACCESS_TOKEN = "THAAhK47kYfANBUVRjQTBVTk9CenNSQ0Vjd1ZApNFRXOTRyMlhJXzBCc04xalZA0VlBOblVhVjFMRThnZAGNqOFV5TXJIWThJaVhXOFFiRkFxMHFFbllyYlYtQnlZAQlNWNGdmNzNldHh4c1BJbm1wOWhyTFd4R0xMUXBhN1VfdTBpSG5halNuS09XYUNJbzFkcTAZD";
const API = "https://graph.threads.net/v1.0";

async function apiFetch(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message + " (code " + d.error.code + ")");
  return d;
}

// ── Own profile & stats ───────────────────────────────────────

async function getProfile() {
  return await apiFetch(`${API}/me?fields=username,name,threads_profile_picture_url,threads_biography,followers_count&access_token=${ACCESS_TOKEN}`);
}

async function getTodayStats() {
  const today = new Date().toISOString().slice(0, 10);
  const since = Math.floor(new Date(today + "T00:00:00Z") / 1000);
  const until = Math.floor(Date.now() / 1000);

  let views = null;
  try {
    const vd = await apiFetch(`${API}/${USER_ID}/threads_insights?metric=views&since=${since}&until=${until}&period=day&access_token=${ACCESS_TOKEN}`);
    views = vd?.data?.[0]?.values?.reduce((s, v) => s + (v.value || 0), 0) ?? null;
  } catch {}

  let posts = [], cursor = null;
  for (let i = 0; i < 10; i++) {
    let url = `${API}/me/threads?fields=id,text,timestamp,permalink,is_reply&limit=50&access_token=${ACCESS_TOKEN}`;
    if (cursor) url += `&after=${cursor}`;
    const d = await apiFetch(url);
    if (!d.data?.length) break;
    let hitOld = false;
    for (const p of d.data) {
      if (!p.timestamp) continue;
      const day = new Date(p.timestamp).toISOString().slice(0, 10);
      if (day === today) posts.push(p);
      else if (day < today) hitOld = true;
    }
    if (hitOld) break;
    cursor = d.paging?.cursors?.after;
    if (!cursor) break;
  }

  let replies = [];
  try {
    let rcursor = null;
    for (let i = 0; i < 10; i++) {
      let url = `${API}/me/replies?fields=id,text,timestamp,permalink,is_reply,replied_to&limit=50&access_token=${ACCESS_TOKEN}`;
      if (rcursor) url += `&after=${rcursor}`;
      const d = await apiFetch(url);
      if (!d.data?.length) break;
      let hitOld = false;
      for (const p of d.data) {
        if (!p.timestamp) continue;
        const day = new Date(p.timestamp).toISOString().slice(0, 10);
        if (day === today && !p.replied_to) replies.push(p);
        else if (day < today) hitOld = true;
      }
      if (hitOld) break;
      rcursor = d.paging?.cursors?.after;
      if (!rcursor) break;
    }
  } catch {}

  return { views, postsCount: posts.length, repliesCount: replies.length, posts, replies };
}

async function getPostInsights(postId) {
  const d = await apiFetch(`${API}/${postId}/insights?metric=likes,replies,reposts,quotes,views&access_token=${ACCESS_TOKEN}`);
  const r = {};
  d.data?.forEach(m => { r[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0; });
  return r;
}

async function getTopPosts(limit = 5) {
  const { posts } = await getTodayStats();
  const insights = await Promise.all(posts.map(p => getPostInsights(p.id).catch(() => null)));
  return posts.map((p, i) => ({ ...p, insights: insights[i] }))
    .sort((a, b) => (b.insights?.views || 0) - (a.insights?.views || 0))
    .slice(0, limit);
}

// ── Publishing ────────────────────────────────────────────────

async function createPost(text, replyToId = null) {
  const body = { text, media_type: "TEXT", access_token: ACCESS_TOKEN };
  if (replyToId) body.reply_to_id = replyToId;

  const createRes = await fetch(`${API}/me/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const createData = await createRes.json();
  if (createData.error) throw new Error(createData.error.message + " (code " + createData.error.code + ")");

  await new Promise(r => setTimeout(r, 1000));
  const publishRes = await fetch(`${API}/me/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: createData.id, access_token: ACCESS_TOKEN }),
  });
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(publishData.error.message + " (code " + publishData.error.code + ")");

  await new Promise(r => setTimeout(r, 1500));
  try {
    const detail = await apiFetch(`${API}/${publishData.id}?fields=id,permalink&access_token=${ACCESS_TOKEN}`);
    return { success: true, id: publishData.id, permalink: detail.permalink };
  } catch {
    return { success: true, id: publishData.id };
  }
}

// ── Reading others' posts ─────────────────────────────────────

// Extract post ID from a Threads URL or return as-is if already an ID
function parsePostId(idOrUrl) {
  if (!idOrUrl) throw new Error("post_id is required");
  // https://www.threads.net/@username/post/ABC123def
  const match = idOrUrl.match(/\/post\/([A-Za-z0-9_-]+)/);
  if (match) return match[1]; // this is a shortcode, not numeric ID
  // If it looks like a numeric ID already
  if (/^\d+$/.test(idOrUrl)) return idOrUrl;
  return idOrUrl;
}

async function getPost(idOrUrl) {
  // If URL given, we need to resolve via oembed or direct lookup
  let postId = parsePostId(idOrUrl);

  // Try direct lookup first (works if it's a numeric ID)
  if (/^\d+$/.test(postId)) {
    return await apiFetch(`${API}/${postId}?fields=id,text,timestamp,permalink,username,likes_count,replies_count&access_token=${ACCESS_TOKEN}`);
  }

  // If shortcode/URL, use oembed to get post details
  const encoded = encodeURIComponent(idOrUrl.startsWith("http") ? idOrUrl : `https://www.threads.net/t/${postId}`);
  const oembed = await apiFetch(`${API}/instagram_oembed?url=${encoded}&access_token=${ACCESS_TOKEN}`).catch(() => null);
  if (oembed) return oembed;

  throw new Error("Could not resolve post. Please provide a numeric post ID or full Threads URL.");
}

async function getPostReplies(postId, limit = 20) {
  const id = parsePostId(postId);
  const d = await apiFetch(`${API}/${id}/replies?fields=id,text,timestamp,permalink,username&limit=${limit}&access_token=${ACCESS_TOKEN}`);
  return d.data || [];
}

async function searchPosts(query, limit = 10) {
  // Threads API doesn't have a public search endpoint yet, so we search within own posts
  // and also try keyword via hashtag if query looks like one
  const q = query.trim().toLowerCase();

  // Check if it's a hashtag search
  if (q.startsWith("#")) {
    const tag = q.slice(1);
    try {
      const d = await apiFetch(`${API}/tags/${encodeURIComponent(tag)}/recent_posts?fields=id,text,timestamp,permalink,username&limit=${limit}&access_token=${ACCESS_TOKEN}`);
      return { source: "hashtag", tag, results: d.data || [] };
    } catch (e) {
      return { source: "hashtag", tag, results: [], error: e.message };
    }
  }

  // Otherwise search within own posts
  const { posts } = await getTodayStats();
  const allPosts = posts;
  const filtered = allPosts.filter(p => p.text && p.text.toLowerCase().includes(q));
  return { source: "own_posts", query, results: filtered.slice(0, limit) };
}

async function getUserPosts(username, limit = 10) {
  // Look up user by username first
  try {
    const user = await apiFetch(`${API}/${username}?fields=id,username,name,threads_biography,followers_count&access_token=${ACCESS_TOKEN}`);
    const posts = await apiFetch(`${API}/${user.id}/threads?fields=id,text,timestamp,permalink,username&limit=${limit}&access_token=${ACCESS_TOKEN}`);
    return {
      user: { id: user.id, username: user.username, name: user.name, followers: user.followers_count },
      posts: posts.data || []
    };
  } catch (e) {
    throw new Error(`Could not find user @${username}: ${e.message}`);
  }
}

// ── MCP Tools ────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_profile",
    description: "Get own Threads profile info: username, followers count, bio",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_today_stats",
    description: "Get today's Threads stats: total views, number of posts and replies",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_today_posts",
    description: "Get list of today's posts with text and timestamps",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_post_insights",
    description: "Get detailed insights for a specific post: views, likes, replies, reposts, quotes",
    inputSchema: {
      type: "object",
      properties: { post_id: { type: "string", description: "Threads post ID" } },
      required: ["post_id"]
    }
  },
  {
    name: "get_top_posts",
    description: "Get today's top performing posts sorted by views",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many top posts to return (default 5)" } }
    }
  },
  {
    name: "create_post",
    description: "Publish a new post on Threads",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text content of the post" }
      },
      required: ["text"]
    }
  },
  {
    name: "reply_to_post",
    description: "Reply to any Threads post (own or someone else's) by post ID or URL",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string", description: "Numeric post ID or full Threads post URL" },
        text: { type: "string", description: "The reply text" }
      },
      required: ["post_id", "text"]
    }
  },
  {
    name: "get_post",
    description: "Get the content and details of any Threads post by its ID or URL",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string", description: "Numeric post ID or full Threads post URL (e.g. https://www.threads.net/@user/post/ABC123)" }
      },
      required: ["post_id"]
    }
  },
  {
    name: "get_post_replies",
    description: "Get all replies to a specific Threads post",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string", description: "Numeric post ID or full Threads URL" },
        limit: { type: "number", description: "Max number of replies to return (default 20)" }
      },
      required: ["post_id"]
    }
  },
  {
    name: "get_user_posts",
    description: "Get recent posts from any Threads user by their username",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "Threads username without @ (e.g. zuck)" },
        limit: { type: "number", description: "Max number of posts to return (default 10)" }
      },
      required: ["username"]
    }
  },
  {
    name: "search_posts",
    description: "Search posts by keyword (searches own posts) or by hashtag (use # prefix, e.g. #ai)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or hashtag (e.g. 'marketing' or '#ai')" },
        limit: { type: "number", description: "Max results (default 10)" }
      },
      required: ["query"]
    }
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case "get_profile":
      return await getProfile();
    case "get_today_stats": {
      const s = await getTodayStats();
      return { date: new Date().toISOString().slice(0, 10), views: s.views, posts: s.postsCount, replies: s.repliesCount };
    }
    case "get_today_posts": {
      const s = await getTodayStats();
      return s.posts.map(p => ({
        id: p.id, text: p.text,
        time: new Date(p.timestamp).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" }),
        permalink: p.permalink
      }));
    }
    case "get_post_insights":
      return await getPostInsights(args.post_id);
    case "get_top_posts":
      return await getTopPosts(args.limit || 5);
    case "create_post":
      return await createPost(args.text);
    case "reply_to_post":
      return await createPost(args.text, args.post_id);
    case "get_post":
      return await getPost(args.post_id);
    case "get_post_replies":
      return await getPostReplies(args.post_id, args.limit || 20);
    case "get_user_posts":
      return await getUserPosts(args.username, args.limit || 10);
    case "search_posts":
      return await searchPosts(args.query, args.limit || 10);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── SSE MCP Handler ───────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: { serverInfo: { name: "threads-mcp", version: "1.0.0" }, capabilities: { tools: {} } } })}\n\n`);
    req.on("close", () => res.end());
    return;
  }

  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);

    if (msg.method === "initialize") {
      res.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "threads-mcp", version: "1.0.0" }, capabilities: { tools: {} } } });
      return;
    }
    if (msg.method === "tools/list") {
      res.json({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      return;
    }
    if (msg.method === "tools/call") {
      try {
        const result = await handleToolCall(msg.params.name, msg.params.arguments || {});
        res.json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      } catch (e) {
        res.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } });
      }
      return;
    }
    res.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}
