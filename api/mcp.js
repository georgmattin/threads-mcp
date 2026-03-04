const USER_ID = "34671307055793656";
const ACCESS_TOKEN = "THAAhK47kYfANBUVRjQTBVTk9CenNSQ0Vjd1ZApNFRXOTRyMlhJXzBCc04xalZA0VlBOblVhVjFMRThnZAGNqOFV5TXJIWThJaVhXOFFiRkFxMHFFbllyYlYtQnlZAQlNWNGdmNzNldHh4c1BJbm1wOWhyTFd4R0xMUXBhN1VfdTBpSG5halNuS09XYUNJbzFkcTAZD";
const API = "https://graph.threads.net/v1.0";

async function apiFetch(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message + " (code " + d.error.code + ")");
  return d;
}

async function getProfile() {
  return await apiFetch(`${API}/me?fields=username,name,threads_profile_picture_url,threads_biography,followers_count&access_token=${ACCESS_TOKEN}`);
}

async function getTodayStats() {
  const today = new Date().toISOString().slice(0, 10);
  const since = Math.floor(new Date(today + "T00:00:00Z") / 1000);
  const until = Math.floor(Date.now() / 1000);

  // Fetch views
  let views = null;
  try {
    const vd = await apiFetch(`${API}/${USER_ID}/threads_insights?metric=views&since=${since}&until=${until}&period=day&access_token=${ACCESS_TOKEN}`);
    views = vd?.data?.[0]?.values?.reduce((s, v) => s + (v.value || 0), 0) ?? null;
  } catch {}

  // Fetch today's posts
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

  // Fetch today's replies
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

// ── MCP Protocol ─────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_profile",
    description: "Get Threads profile info: username, followers count, bio",
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
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case "get_profile":
      return await getProfile();
    case "get_today_stats": {
      const s = await getTodayStats();
      return {
        date: new Date().toISOString().slice(0, 10),
        views: s.views,
        posts: s.postsCount,
        replies: s.repliesCount
      };
    }
    case "get_today_posts": {
      const s = await getTodayStats();
      return s.posts.map(p => ({
        id: p.id,
        text: p.text,
        time: new Date(p.timestamp).toLocaleTimeString("et-EE", { hour: "2-digit", minute: "2-digit" }),
        permalink: p.permalink
      }));
    }
    case "get_post_insights":
      return await getPostInsights(args.post_id);
    case "get_top_posts":
      return await getTopPosts(args.limit || 5);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── SSE MCP Handler ───────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  // SSE stream
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // Send server info
    send({
      jsonrpc: "2.0", method: "notifications/initialized",
      params: { serverInfo: { name: "threads-mcp", version: "1.0.0" }, capabilities: { tools: {} } }
    });

    req.on("close", () => res.end());
    return;
  }

  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);

    // Initialize
    if (msg.method === "initialize") {
      res.json({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "threads-mcp", version: "1.0.0" },
          capabilities: { tools: {} }
        }
      });
      return;
    }

    // List tools
    if (msg.method === "tools/list") {
      res.json({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      return;
    }

    // Call tool
    if (msg.method === "tools/call") {
      try {
        const result = await handleToolCall(msg.params.name, msg.params.arguments || {});
        res.json({
          jsonrpc: "2.0", id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
        });
      } catch (e) {
        res.json({
          jsonrpc: "2.0", id: msg.id,
          error: { code: -32000, message: e.message }
        });
      }
      return;
    }

    res.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}
