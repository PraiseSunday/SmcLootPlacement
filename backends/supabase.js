// Pin store on Supabase. Schema + RLS policies: db/schema.sql.
import { createClient } from "@supabase/supabase-js";

export function createStore({ url, key }) {
  const sb = createClient(url, key);
  const ok = ({ data, error }) => { if (error) throw error; return data; };
  return {
    needsEmail: true,
    list: async () => ok(await sb.from("pins").select("*")),
    insert: async (pin) => ok(await sb.from("pins").insert(pin).select().single()),
    vote: async (id, delta) => ok(await sb.rpc("increment_vote", { pin_id: id, delta })),
    remove: async (id) => ok(await sb.from("pins").delete().eq("id", id)),
    hasKind: async () => !(await sb.from("pins").select("kind").limit(1)).error,
    subscribe(onChange) {
      sb.channel("pins-changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "pins" }, onChange)
        .subscribe();
    },
    auth: {
      isAdmin: async () => !!(await sb.auth.getSession()).data.session,
      onChange: (cb) => sb.auth.onAuthStateChange((_e, s) => cb(!!s)),
      signIn: async (email, password) => ok(await sb.auth.signInWithPassword({ email, password })),
      signOut: async () => { await sb.auth.signOut(); },
    },
  };
}
