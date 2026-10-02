// Where pins are stored. Pick ONE backend.
//
//   "rest"      -> the bundled server (server/server.py, SQLite). Zero setup:
//                  `python3 server/server.py` and open http://localhost:8934
//   "supabase"  -> a Supabase project (see db/schema.sql). Fill in url + key.
//
// To use any other database, implement the same small interface as
// backends/rest.js (list / insert / vote / remove) -- see README "Database".
export default {
  backend: "rest",
  rest: { baseUrl: "/api" },
  supabase: {
    url: "https://YOUR-PROJECT.supabase.co",
    key: "YOUR-PUBLISHABLE-ANON-KEY",
  },
};
