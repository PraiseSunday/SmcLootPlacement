// Pin store over plain HTTP+JSON. Contract (implemented by server/server.py):
//   GET    {base}/pins                -> [pin]
//   POST   {base}/pins   {x,y,z,kind,tier,note} -> pin
//   POST   {base}/pins/:id/vote {delta}         -> pin
//   DELETE {base}/pins/:id            (admin)   -> 204
//   GET    {base}/admin               (admin)   -> 204 / 401
// Admin = "Authorization: Bearer <token>". Point baseUrl at any server that
// speaks this and the front end works unchanged.
const POLL_MS = 5000;

export function createStore({ baseUrl }) {
  let token = sessionStorage.getItem("slp-admin-token") || "";
  const listeners = new Set();
  const call = async (path, opts = {}) => {
    const res = await fetch(baseUrl + path, {
      ...opts,
      cache: "no-cache",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
    });
    if (!res.ok) throw new Error((await res.text().catch(() => "")) || res.statusText);
    return res.status === 204 ? null : res.json();
  };
  const setToken = (t) => {
    token = t;
    t ? sessionStorage.setItem("slp-admin-token", t) : sessionStorage.removeItem("slp-admin-token");
    listeners.forEach((cb) => cb(!!t));
  };
  return {
    needsEmail: false,
    list: () => call("/pins"),
    insert: (pin) => call("/pins", { method: "POST", body: JSON.stringify(pin) }),
    vote: (id, delta) => call(`/pins/${id}/vote`, { method: "POST", body: JSON.stringify({ delta }) }),
    remove: (id) => call(`/pins/${id}`, { method: "DELETE" }),
    // Pin kinds always exist on this backend.
    hasKind: async () => true,
    // No push channel in plain HTTP: poll, and let the app re-list.
    subscribe(onChange) {
      setInterval(() => !document.hidden && onChange(), POLL_MS);
    },
    auth: {
      isAdmin: async () => {
        if (!token) return false;
        try { await call("/admin"); return true; } catch { setToken(""); return false; }
      },
      onChange: (cb) => listeners.add(cb),
      signIn: async (_email, password) => {
        setToken(password);
        if (!(await call("/admin").then(() => true, () => false))) {
          setToken("");
          throw new Error("Wrong admin token");
        }
      },
      signOut: async () => setToken(""),
    },
  };
}
