# Debugging AI Translation Issues

## Symptoms

- Click "Translate with AI" button
- Nothing happens or request doesn't appear to be sent
- No error message displayed

## How to Debug

### 1. Open Browser Developer Console

**Chrome/Edge:**

- Press `F12` or `Ctrl+Shift+I`
- Click on the **Console** tab

**Firefox:**

- Press `F12` or `Ctrl+Shift+K`
- Click on the **Console** tab

### 2. Check Console Logs

After clicking "Translate with AI", you should see detailed logs:

```
🔥 Starting AI translation process...
Selected model: GPT-4 (gpt-4)
Original file: document.docx
Target language: es
📝 Full prompt: Translate this document...
⏳ Calling translation service...
🚀 Starting OpenAI translation...
Model: gpt-4
Target Language: es
File: document.docx Size: 12345 bytes
✅ API key found: sk-proj-ab...
📖 Reading file content...
✅ File read successfully. Content length: 5000 characters
📤 Sending request to OpenAI API...
Request URL: https://api.openai.com/v1/chat/completions
📥 Response received. Status: 200 OK
✅ API request successful. Parsing response...
✅ Translation completed. Length: 5500 characters
🎉 Translation completed successfully!
```

### 3. Common Issues & Solutions

#### Issue 1: No API Key Found

```
❌ No OpenAI API key found in localStorage
```

**Solution:**

1. Go to **Settings** in the app
2. Add your OpenAI API key
3. Click "Save AI Keys"
4. Try translation again

#### Issue 2: CORS Error

```
Access to fetch at 'https://api.openai.com/v1/chat/completions' from origin 'http://localhost:4200'
has been blocked by CORS policy
```

**Solution:** This is the most common issue. Browsers block direct API calls to third-party APIs for security reasons.

**Fix Option A: Use a Backend Proxy (Recommended)**

1. Create a backend proxy server:

```javascript
// server.js
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.post("/api/translate", async (req, res) => {
  const { model, messages, apiKey } = req.body;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log("Proxy server running on port 3000"));
```

2. Install dependencies:

```bash
npm install express cors node-fetch
```

3. Run the proxy:

```bash
node server.js
```

4. Update your Angular service to use the proxy endpoint instead of calling OpenAI directly.

**Fix Option B: Use Browser Extension (Development Only)**

Install a CORS browser extension:

- Chrome: "Allow CORS: Access-Control-Allow-Origin"
- Firefox: "CORS Everywhere"

⚠️ **Warning:** Only use this for local development. NEVER deploy with CORS disabled.

**Fix Option C: Use Angular Proxy (Development)**

1. Create `proxy.conf.json`:

```json
{
  "/openai-api": {
    "target": "https://api.openai.com",
    "secure": true,
    "changeOrigin": true,
    "pathRewrite": {
      "^/openai-api": ""
    }
  }
}
```

2. Update `angular.json`:

```json
"serve": {
  "options": {
    "proxyConfig": "proxy.conf.json"
  }
}
```

3. Update the API URL in your service to use `/openai-api/v1/chat/completions`

#### Issue 3: Invalid API Key

```
❌ OpenAI API request failed
Error details: { error: { message: "Incorrect API key provided" } }
```

**Solution:**

1. Verify your API key is correct
2. Check if the key starts with `sk-` (OpenAI) or `sk-ant-` (Anthropic)
3. Regenerate the key from the provider's dashboard
4. Update it in Settings

#### Issue 4: Rate Limit Exceeded

```
❌ OpenAI API error: Rate limit exceeded
```

**Solution:**

- Wait a few minutes before trying again
- Check your usage limits in OpenAI dashboard
- Upgrade your API plan if needed

#### Issue 5: Token Limit Exceeded

```
❌ OpenAI API error: Maximum context length exceeded
```

**Solution:**

- Your file is too large
- Split the document into smaller chunks
- Use a model with larger context (e.g., GPT-4-turbo)
- Reduce the file size

#### Issue 6: Network Error

```
Failed to fetch
TypeError: Failed to fetch
```

**Solution:**

- Check your internet connection
- Verify the API endpoint is accessible
- Check if a firewall is blocking requests
- Try disabling VPN/proxy temporarily

### 4. Check Network Tab

1. Open **Network** tab in Developer Tools
2. Click "Translate with AI"
3. Look for a request to `api.openai.com` (or other AI provider)

**What to check:**

- **Request sent?** If no request appears, the function might not be triggered
- **Request status?** Look for status code (200 = success, 4xx/5xx = error)
- **Request headers?** Verify Authorization header is present
- **Response?** Check the response content

### 5. Test API Key Directly

Test your API key outside the app:

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 10
  }'
```

If this works, your API key is valid.

### 6. Check localStorage

Open Console and run:

```javascript
console.log("OpenAI Key:", localStorage.getItem("openai_api_key"));
console.log("Anthropic Key:", localStorage.getItem("anthropic_api_key"));
console.log("Google Key:", localStorage.getItem("google_api_key"));
```

Verify your API keys are stored correctly.

### 7. File Size Check

Large files may cause timeouts:

```javascript
console.log("File size:", originalFile.size / 1024, "KB");
```

**Recommendations:**

- Keep files under 100KB for best performance
- Text files work best (TXT, MD, HTML, JSON)
- Binary files (DOCX, PDF) need additional processing

## Quick Fix Checklist

- [ ] API key is added in Settings
- [ ] Browser console is open to see logs
- [ ] Network tab shows the request being sent
- [ ] No CORS errors in console
- [ ] File size is reasonable (<100KB)
- [ ] Internet connection is stable
- [ ] API key is valid (test with curl)

## Still Not Working?

If you've checked all the above and it's still not working:

1. **Clear browser cache and localStorage:**

   ```javascript
   localStorage.clear();
   location.reload();
   ```

2. **Try a different browser** (Chrome, Firefox, Edge)

3. **Check if your organization blocks AI API calls**

4. **Use the backend proxy solution** (most reliable)

## Working Solution

The most reliable solution for production is:

1. **Create a backend API** (Node.js, Python, etc.)
2. **Store API keys server-side** (not in browser)
3. **Frontend calls your backend** (no CORS issues)
4. **Backend calls AI provider** (OpenAI, Anthropic, etc.)
5. **Backend returns result to frontend**

This approach:

- ✅ Avoids CORS issues
- ✅ Keeps API keys secure
- ✅ Allows rate limiting
- ✅ Enables usage tracking
- ✅ Works in all browsers

---

**Need More Help?**

Share the console logs and Network tab screenshots for further diagnosis.
