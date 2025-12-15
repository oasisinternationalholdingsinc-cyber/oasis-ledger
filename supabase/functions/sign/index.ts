// supabase/functions/sign/index.ts
Deno.serve((_req)=>{
  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Sign DEBUG</title>
  </head>
  <body>
    <h1>HELLO FROM SIGN 🎉</h1>
    <p>If this line is big and bold as a heading, HTML is working.</p>
    <p>If you see the <code>&lt;h1&gt;</code> tags, something is still wrapping it.</p>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
});
