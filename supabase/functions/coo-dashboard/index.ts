import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { CSS_HTML } from "./css_html.ts";
import { JS_PRIMITIVES } from "./primitives.ts";
import { JS_AUTH } from "./auth.ts";
import { JS_OPS } from "./ops.ts";
import { JS_SYS } from "./system.ts";
const HTML = CSS_HTML + '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n' + '<script>\n' + JS_PRIMITIVES + '\n</script>\n' + '<script>\n' + JS_AUTH + '\n</script>\n' + '<script>\n' + JS_OPS + '\n</script>\n' + '<script>\n' + JS_SYS + '\n</script>\n' + '</body>\n</html>';
Deno.serve((_req)=>{
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    }
  });
});
