const ACCESS_TOKEN = "THAAhK47kYfANBUVJUb05WMG1rUUZAJRjZAFUHpGSkx0MEN5WGhOTnlRS21KLWc0N0t3Y29EVU1RX09RWnNVTFBGUVR0TE5KcFZAKdDhoSHhHdnR0TjFnN2tHcHRwN1p3eUhHRWFXazltVU93TGJZAeFcxdENoQ1N1Skx0SF92M1V3bm9BNFIzUm9XejQ0Rk5rd2sZD";
const USER_ID = "34671307055793656";
const API = "https://graph.threads.net/v1.0";

// Paste your Apps Script Web App URL here after deploying
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || "";

async function apiFetch(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d;
}

async function getYesterdayPosts() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const targetDate = yesterday.toISOString().slice(0, 10);

  let posts = [], cursor = null;
  for (let i = 0; i < 15; i++) {
    let url = `${API}/me/threads?fields=id,text,timestamp,permalink&limit=100&access_token=${ACCESS_TOKEN}`;
    if (cursor) url += `&after=${cursor}`;
    const d = await apiFetch(url);
    if (!d.data?.length) break;
    let hitOlder = false;
    for (const p of d.data) {
      if (!p.timestamp) continue;
      const day = new Date(p.timestamp).toISOString().slice(0, 10);
      if (day === targetDate && p.text) posts.push(p);
      else if (day < targetDate) hitOlder = true;
    }
    if (hitOlder) break;
    cursor = d.paging?.cursors?.after;
    if (!cursor) break;
  }
  return { posts, date: targetDate };
}

async function getInsights(postId) {
  try {
    const d = await apiFetch(`${API}/${postId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${ACCESS_TOKEN}`);
    const r = {};
    d.data?.forEach(m => { r[m.name] = m.values?.[0]?.value ?? m.total_value?.value ?? 0; });
    return r;
  } catch { return { views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 }; }
}

export default async function handler(req, res) {
  // Allow manual trigger via GET too (for testing)
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { posts, date } = await getYesterdayPosts();

    if (!posts.length) {
      return res.json({ success: true, message: `No posts found for ${date}` });
    }

    // Fetch insights for all posts (throttled)
    const withInsights = [];
    for (const post of posts) {
      const ins = await getInsights(post.id);
      withInsights.push({ ...post, ...ins });
      await new Promise(r => setTimeout(r, 150));
    }

    // Score = views + (likes * 3) + (replies * 5) + (reposts * 4) + (quotes * 2)
    const scored = withInsights
      .map(p => ({
        ...p,
        score: (p.views || 0) + (p.likes || 0) * 3 + (p.replies || 0) * 5 + (p.reposts || 0) * 4 + (p.quotes || 0) * 2
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    // Send to Apps Script
    if (APPS_SCRIPT_URL) {
      await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, posts: scored }),
      });
    }

    res.json({ success: true, date, postsProcessed: posts.length, topPosts: scored.length, data: scored });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
