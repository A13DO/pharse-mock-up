# AI DOCX Translation Component

A powerful Angular 19 standalone component for AI-powered DOCX translation with support for multiple AI providers.

## Features

✅ **Multiple AI Providers**

- Anthropic Claude Sonnet 4
- OpenAI GPT-4o
- Google Gemini 1.5 Pro

✅ **Smart Document Processing**

- Extract text from DOCX files using Mammoth.js
- Preserve formatting: # H1, ## H2, ### H3, **bold**
- Rebuild DOCX with formatting using docx.js

✅ **Modern Angular 19**

- Standalone component (no NgModules)
- Signals-based state management
- New control flow syntax (@if, @for, @switch)

✅ **Developer Experience**

- Dark theme with provider-specific accent colors
- Drag & drop file upload
- Quick-prompt examples
- localStorage API key persistence
- 3-step progress indicator
- Comprehensive error handling

## Installation

### 1. Install Required Packages

```bash
npm install mammoth docx
npm install --save-dev @types/mammoth
```

### 2. Component Files

The component consists of:

- `src/app/services/docx-translation.service.ts` - Translation service
- `src/app/translation/translation.component.ts` - Component logic
- `src/app/translation/translation.component.html` - Template
- `src/app/translation/translation.component.scss` - Styles

### 3. Add to Routes

The component is already added to `app.routes.ts`:

```typescript
{
  path: 'ai-translate',
  loadComponent: () =>
    import('./translation/translation.component').then(
      (m) => m.TranslationComponent,
    ),
}
```

### 4. Navigation

A menu item has been added to the sidebar:

- Path: `/ai-translate`
- Label: "AI Translation"
- Icon: Lightning bolt

## Usage

### Basic Workflow

1. **Navigate** to "AI Translation" in the sidebar
2. **Select Provider** (Anthropic, OpenAI, or Gemini)
3. **Enter API Key** (saved automatically to localStorage)
4. **Upload DOCX File** (drag & drop or click to browse)
5. **Write Custom Prompt** or use a quick example
6. **Click Translate**
7. **Download Result** when complete

### API Keys

Get your API keys from:

- **Anthropic**: https://console.anthropic.com/
- **OpenAI**: https://platform.openai.com/api-keys
- **Google Gemini**: https://aistudio.google.com/app/apikey

API keys are stored in localStorage:

- `docx_ai_key_anthropic`
- `docx_ai_key_openai`
- `docx_ai_key_gemini`

### Provider Configuration

#### Anthropic Claude

- **Model**: `claude-sonnet-4-20250514`
- **Endpoint**: `https://api.anthropic.com/v1/messages`
- **Header**: `x-api-key`
- **Max Tokens**: 8192

#### OpenAI GPT-4o

- **Model**: `gpt-4o`
- **Endpoint**: `https://api.openai.com/v1/chat/completions`
- **Header**: `Authorization: Bearer`
- **Max Tokens**: 8192

#### Google Gemini

- **Model**: `gemini-1.5-pro`
- **Endpoint**: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent`
- **Query Param**: `key=API_KEY`
- **Max Tokens**: Automatic

## Component Architecture

### Service Layer (`docx-translation.service.ts`)

```typescript
export type Provider = 'anthropic' | 'openai' | 'gemini';

async translateDocument(
  file: File,
  customPrompt: string,
  provider: Provider,
  apiKey: string
): Promise<{ blob: Blob; filename: string }>
```

**Process Flow:**

1. Extract text from DOCX using `mammoth.extractRawText()`
2. Call selected AI provider API directly from browser
3. Normalize response across providers
4. Rebuild DOCX with formatting using `docx.js`
5. Return Blob + filename

### Component (`translation.component.ts`)

**Signals:**

- `selectedProvider` - Active AI provider
- `apiKey` - Current API key (persisted)
- `uploadedFile` - Uploaded DOCX file
- `customPrompt` - Translation instructions
- `progressStep` - Current processing step
- `errorMessage` - Error state
- `translatedBlob` - Result blob
- `isDragging` - Drag-and-drop state

**Computed:**

- `canTranslate` - Enable/disable translate button
- `isProcessing` - Show/hide progress indicator
- `fileInfo` - File name and size display
- `progressMessage` - Step-specific message

## Styling

### Dark Theme

The component uses CSS custom properties for theming:

```scss
--bg-primary: #0f1419 --bg-secondary: #1a1f29 --bg-tertiary: #242b38 --text-primary: #e4e6eb --text-secondary: #8b92a5;
```

### Provider Colors

Each provider has a unique accent color:

- **Anthropic**: `#c96442` (Warm orange-red)
- **OpenAI**: `#10a37f` (Teal green)
- **Gemini**: `#4285f4` (Google blue)

Active provider card glows with its accent color using box-shadow.

## CORS Considerations

⚠️ **Important**: This component calls AI APIs directly from the browser. CORS may be an issue in production.

### Development (Testing)

For local testing, you can:

1. Use a CORS browser extension (Chrome: "Allow CORS", Firefox: "CORS Everywhere")
2. Test with providers that allow browser requests

### Production (Recommended)

For production deployments, create a backend proxy:

```javascript
// Example Node.js proxy
app.post("/api/translate", async (req, res) => {
  const { provider, prompt, text, apiKey } = req.body;

  const response = await fetch(getProviderUrl(provider), {
    method: "POST",
    headers: getProviderHeaders(provider, apiKey),
    body: JSON.stringify(getProviderBody(provider, prompt, text)),
  });

  const data = await response.json();
  res.json(data);
});
```

Then update the service to call `/api/translate` instead of provider URLs directly.

## Error Handling

The component provides detailed error messages:

- **401/403**: "Check your API key" hint
- **Network errors**: Shows full error message
- **Invalid responses**: Handles unexpected data formats
- **Provider-specific errors**: Extracts meaningful messages

Example errors:

```
Anthropic API error: invalid_request_error (Check your API key)
OpenAI API error: Incorrect API key provided (Check your API key)
Network error calling gemini: Failed to fetch
```

## Quick Prompts

Pre-configured examples for common use cases:

1. "Translate this document to Spanish while maintaining professional tone..."
2. "Translate to French. Keep all proper nouns and brand names unchanged."
3. "Translate to German. Preserve all formatting, bullet points, and numbered lists..."
4. "Translate to Japanese. Use formal language appropriate for business documentation."

Users can click any chip to populate the textarea.

## Formatting Support

The component preserves markdown-style formatting:

- `# Heading 1` → H1
- `## Heading 2` → H2
- `### Heading 3` → H3
- `**bold text**` → Bold

Example:

```markdown
# Project Overview

This is the **main objective** of our initiative.

## Key Features

- Feature one
- Feature two
```

## Performance

**File Size Limits:**

- Recommended: < 5 MB
- Maximum tokens: 8192 per request
- Large files may be truncated

**Processing Time:**

- Small files (< 100 KB): 5-15 seconds
- Medium files (100-500 KB): 15-30 seconds
- Large files (> 500 KB): 30+ seconds

## Troubleshooting

### "Check your API key" Error

1. Verify API key is correct (no extra spaces)
2. Check provider dashboard for key validity
3. Ensure sufficient credits/quota

### File Upload Issues

1. Only `.docx` files are supported
2. File must not be password-protected
3. Check file is not corrupted

### CORS Errors

```
Access to fetch blocked by CORS policy
```

**Solution**: Use a backend proxy server (see CORS Considerations above)

### Network Timeout

- Check internet connection
- Try smaller file
- Switch to different provider

## Development

### Running Locally

```bash
# Install dependencies
npm install

# Start dev server
npm start

# Navigate to http://localhost:4200/ai-translate
```

### Building for Production

```bash
npm run build
```

### Testing Different Providers

1. Get API keys for all three providers
2. Test with same document on each
3. Compare translation quality and speed

## Future Enhancements

Potential improvements:

- [ ] Support for more file formats (PDF, TXT, MD)
- [ ] Batch translation for multiple files
- [ ] Translation memory/glossary
- [ ] Cost estimation before translating
- [ ] Progress streaming from AI providers
- [ ] Compare translations side-by-side
- [ ] Export to multiple formats

## License

This component is part of the Phrase TMS API Client project.

## Support

For issues or questions:

1. Check browser console for detailed error logs
2. Verify API keys are valid
3. Test with a simple DOCX file first
4. Review CORS considerations for production

---

**Built with Angular 19** | **Standalone Components** | **Signals** | **Modern Control Flow**
