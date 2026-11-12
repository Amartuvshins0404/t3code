export const devicePage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect a device · T3 Code</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #111; --muted: #666; --card: #fff; --line: #ddd; --accent: #111; --accent-fg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0b0c; --fg: #eee; --muted: #999; --card: #161618; --line: #2a2a2e; --accent: #eee; --accent-fg: #111; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: var(--muted); }
  input { width: 100%; padding: 10px 12px; font: 600 20px/1 ui-monospace, monospace; letter-spacing: 0.15em; text-transform: uppercase; text-align: center; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; margin-bottom: 12px; }
  button { width: 100%; padding: 10px 12px; margin-top: 8px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  button:disabled { opacity: 0.5; cursor: default; }
  .row { display: flex; gap: 8px; }
  #status { min-height: 1.5em; margin: 12px 0 0; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>Connect a device</h1>
  <p id="who">Checking your session…</p>
  <section id="signin" hidden>
    <button class="primary" id="github">Continue with GitHub</button>
    <button id="passkey">Sign in with a passkey</button>
  </section>
  <form id="approve" hidden>
    <input id="code" name="user_code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD1234" required>
    <div class="row">
      <button type="submit" class="primary" value="approve">Approve</button>
      <button type="submit" value="deny">Deny</button>
    </div>
    <button type="button" id="addPasskey">Add a passkey to this account</button>
  </form>
  <p id="status" role="status"></p>
</main>
<script>
  const api = (path, init) => fetch("/api/auth" + path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...init })
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && (body.message || body.error_description || body.error)) || res.statusText);
      return body;
    });
  const $ = (id) => document.getElementById(id);
  const say = (text) => { $("status").textContent = text; };
  const params = new URLSearchParams(location.search);
  $("code").value = params.get("user_code") || "";
  const normalize = (value) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  $("github").onclick = async () => {
    try {
      const { url } = await api("/sign-in/social", { method: "POST", body: JSON.stringify({ provider: "github", callbackURL: location.href }) });
      location.href = url;
    } catch (error) { say(error.message); }
  };

  $("passkey").onclick = async () => {
    try {
      const options = await api("/passkey/generate-authenticate-options");
      const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
      await api("/passkey/verify-authentication", { method: "POST", body: JSON.stringify({ response: credential.toJSON() }) });
      location.reload();
    } catch (error) { say(error.message); }
  };

  $("addPasskey").onclick = async () => {
    try {
      const options = await api("/passkey/generate-register-options");
      const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
      await api("/passkey/verify-registration", { method: "POST", body: JSON.stringify({ response: credential.toJSON() }) });
      say("Passkey added.");
    } catch (error) { say(error.message); }
  };

  $("approve").onsubmit = async (event) => {
    event.preventDefault();
    const action = event.submitter && event.submitter.value === "deny" ? "deny" : "approve";
    const userCode = normalize($("code").value);
    for (const button of $("approve").querySelectorAll("button")) button.disabled = true;
    try {
      await api("/device?user_code=" + encodeURIComponent(userCode));
      await api("/device/" + action, { method: "POST", body: JSON.stringify({ userCode }) });
      say(action === "approve" ? "Device approved. You can close this tab." : "Request denied.");
    } catch (error) {
      say(error.message);
      for (const button of $("approve").querySelectorAll("button")) button.disabled = false;
    }
  };

  api("/get-session").then((session) => {
    if (session && session.user) {
      $("who").textContent = "Signed in as " + (session.user.email || session.user.name) + ". Enter the code shown in your terminal.";
      $("approve").hidden = false;
    } else {
      $("who").textContent = "Sign in to approve the code shown in your terminal.";
      $("signin").hidden = false;
    }
  }).catch((error) => say(error.message));
</script>
</body>
</html>
`;
