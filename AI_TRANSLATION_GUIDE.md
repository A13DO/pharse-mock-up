# AI Translation Guide

## Overview

This application now supports real AI-powered document translation using OpenAI, Anthropic, and Google Cloud APIs. Files are uploaded, sent to the AI service with your custom prompt, and translated documents are returned.

## Features

- ✅ **Real API Integration** - No dummy/mock code
- ✅ **Multiple AI Providers** - OpenAI (GPT-4), Anthropic (Claude 3), Google (Gemini)
- ✅ **File Upload** - Upload documents directly from Phrase TMS
- ✅ **Custom Prompts** - Customize translation instructions
- ✅ **Secure Storage** - API keys stored in browser localStorage

## Setup Instructions

### 1. Configure API Keys

Navigate to **Settings** in the application and configure at least one AI service API key:

#### OpenAI (GPT-4, GPT-3.5 Turbo)

1. Go to [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Sign in or create an account
3. Click "Create new secret key"
4. Copy the key (starts with `sk-`)
5. Paste it in the Settings page under "OpenAI API Key"

**Pricing**: ~$0.03 per 1K tokens (GPT-4) or ~$0.002 per 1K tokens (GPT-3.5)

#### Anthropic (Claude 3 Opus, Sonnet)

1. Go to [https://console.anthropic.com/](https://console.anthropic.com/)
2. Sign in or create an account
3. Navigate to API Keys section
4. Generate a new API key (starts with `sk-ant-`)
5. Paste it in the Settings page under "Anthropic API Key"

**Pricing**: ~$0.015 per 1K tokens (Claude 3 Sonnet)

#### Google Cloud (Gemini Pro)

1. Go to [https://console.cloud.google.com/](https://console.cloud.google.com/)
2. Create a project if you don't have one
3. Enable the Cloud Translation API
4. Create an API key in "APIs & Services > Credentials"
5. Paste it in the Settings page under "Google Cloud API Key"

**Note**: Google Cloud Translation requires a project ID to be configured in the code.

### 2. Using AI Translation

1. **Navigate to a Job**: Go to a project and select a job to translate
2. **Download Original File**: Click "Download File" to fetch the document from Phrase TMS
3. **Configure AI Model**: Select your preferred AI model (GPT-4, Claude 3, etc.)
4. **Customize Prompt**: Edit the translation prompt with specific instructions
5. **Add Custom Instructions** (Optional): Include terminology, style guides, or context
6. **Translate**: Click "Translate with AI" to send the file + prompt to the AI service
7. **Download Result**: Download the translated file when complete

## How It Works

### File Processing

```typescript
1. File is downloaded from Phrase TMS as a Blob
2. File is read as text content
3. Content is sent to AI API with custom prompt
4. AI processes and translates the content
5. Translated text is returned as a new file
6. User can download or upload back to Phrase TMS
```

### API Calls

#### OpenAI API

```typescript
POST https://api.openai.com/v1/chat/completions
Headers:
  - Content-Type: application/json
  - Authorization: Bearer YOUR_API_KEY
Body:
  - model: "gpt-4"
  - messages: [system prompt, user prompt + file content]
  - temperature: 0.3
  - max_tokens: 4000
```

#### Anthropic API

```typescript
POST https://api.anthropic.com/v1/messages
Headers:
  - Content-Type: application/json
  - x-api-key: YOUR_API_KEY
  - anthropic-version: 2023-06-01
Body:
  - model: "claude-3-opus"
  - max_tokens: 4096
  - messages: [user prompt + file content]
```

#### Google Cloud Translation

```typescript
POST https://translation.googleapis.com/v3/projects/PROJECT_ID/locations/global:translateText
Headers:
  - Content-Type: application/json
Query Params:
  - key: YOUR_API_KEY
Body:
  - contents: [file content]
  - sourceLanguageCode: "en"
  - targetLanguageCode: "es"
  - mimeType: "text/plain"
```

## Supported File Types

Currently supports text-based files that can be read as plain text:

- `.txt` - Plain text files
- `.md` - Markdown files
- `.html` - HTML files
- `.xml` - XML files
- `.json` - JSON files

For binary formats (DOCX, PDF), you'll need to add additional processing libraries.

## Error Handling

The application handles common errors:

- **Missing API Key**: "OpenAI API key not configured. Please add it in Settings."
- **Invalid API Key**: "OpenAI API error: Incorrect API key provided"
- **Rate Limits**: "OpenAI API error: Rate limit exceeded"
- **Token Limits**: "OpenAI API error: Maximum context length exceeded"
- **Network Errors**: Proper error messages with retry suggestions

## Best Practices

### 1. Optimize Token Usage

- Keep file sizes reasonable (< 100KB for text)
- Use GPT-3.5 for simple translations to save costs
- Break large documents into smaller chunks if needed

### 2. Craft Better Prompts

```
Good Prompt:
"Translate this technical documentation from English to Spanish.
Maintain all code snippets unchanged. Use formal tone.
Keep technical terms in English: API, SDK, endpoint."

Poor Prompt:
"Translate to Spanish"
```

### 3. API Key Security

- Never commit API keys to version control
- Use environment variables for production
- Rotate keys periodically
- Monitor usage in respective dashboards

## Extending the Implementation

### Adding More AI Providers

To add a new AI provider:

1. Add the provider to `availableModels` in `translation.component.ts`
2. Create a new method `translateWithProviderName()` in `translation.service.ts`
3. Implement the API call following the provider's documentation
4. Add API key storage in settings component

### Supporting Binary Files (DOCX, PDF)

```typescript
// Install libraries
npm install mammoth pdf-parse

// For DOCX
import mammoth from 'mammoth';
const result = await mammoth.extractRawText({ buffer: arrayBuffer });

// For PDF
import pdf from 'pdf-parse';
const data = await pdf(buffer);
```

### Adding Streaming Support

For real-time translation display:

```typescript
const response = await fetch(url, {
  ...options,
  headers: { ...headers, Accept: "text/event-stream" },
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value);
  // Process chunk
}
```

## Cost Estimation

Based on average document sizes:

| File Size | GPT-4 | GPT-3.5 | Claude 3 | Gemini |
| --------- | ----- | ------- | -------- | ------ |
| 1 KB      | $0.03 | $0.002  | $0.015   | $0.001 |
| 10 KB     | $0.30 | $0.02   | $0.15    | $0.01  |
| 100 KB    | $3.00 | $0.20   | $1.50    | $0.10  |

_Prices are approximate and subject to change_

## Troubleshooting

### "API key not configured"

→ Go to Settings and add your API key

### "Maximum context length exceeded"

→ File is too large. Split into smaller chunks or use a model with larger context

### "Rate limit exceeded"

→ Wait a few minutes or upgrade your API plan

### Translation quality is poor

→ Improve your prompt with more specific instructions, terminology, and context

## Production Considerations

For production deployments:

1. **Backend Proxy**: Don't expose API keys in frontend
   - Create backend endpoint to proxy AI API calls
   - Validate and sanitize inputs server-side

2. **Rate Limiting**: Implement rate limiting per user

3. **Cost Control**: Set usage limits and quotas

4. **Monitoring**: Track API usage and costs

5. **Caching**: Cache common translations to reduce API calls

6. **Queue System**: For large files, use a job queue (Redis, Bull)

## Support

For issues or questions:

- Check API provider documentation
- Review browser console for detailed errors
- Verify API key validity in respective dashboards

---

**Version**: 1.0  
**Last Updated**: April 2026
