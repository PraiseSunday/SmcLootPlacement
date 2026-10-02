// Picks the pin-storage backend from config.js. app.js only talks to this.
import config from "./config.js";

const mod = await import(config.backend === "supabase" ? "./backends/supabase.js" : "./backends/rest.js");
export default mod.createStore(config[config.backend]);
