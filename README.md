# Phrase TMS API Client

A modern Angular 19 application for interacting with the Phrase TMS (Translation Management System) API. This non-production client provides a clean, minimal interface for managing translation projects.

## Features

- 🔐 **API Token Management** - Securely store and manage your Phrase API token
- 📁 **Project Management** - View all projects with detailed information
- ➕ **Create Projects** - Create new translation projects with full configuration
- 🎨 **Clean UI** - Minimal, responsive design using SCSS
- 🚀 **Angular 19** - Built with standalone components and modern Angular features

## Tech Stack

- **Angular 19** - Standalone components, reactive forms
- **SCSS** - Custom styling with CSS variables
- **HttpClient** - API communication
- **Angular Router** - Navigation
- **TypeScript** - Type-safe development

## Project Structure

```
src/
├── app/
│   ├── core/
│   │   ├── services/
│   │   │   ├── phrase-api.service.ts    # API calls to Phrase TMS
│   │   │   └── auth.service.ts          # Token management
│   │   └── interceptors/
│   │       └── auth.interceptor.ts      # JWT token injection
│   ├── features/
│   │   ├── projects/
│   │   │   ├── projects-list/           # List all projects
│   │   │   └── project-create/          # Create new project
│   │   └── settings/                    # API token settings
│   ├── shared/
│   │   └── components/
│   │       ├── data-table/              # Reusable table
│   │       └── form-field/              # Form field wrapper
│   ├── layout/
│   │   ├── sidebar/                     # Navigation sidebar
│   │   └── header/                      # Page header
│   └── app.component.ts
├── environments/
│   └── environment.ts                   # API configuration
└── styles.scss                          # Global styles
```

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Angular CLI (`npm install -g @angular/cli`)

### Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd pharse-mock-up
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start the development server**

   ```bash
   npm start
   # or
   ng serve
   ```

4. **Open your browser**

   Navigate to `http://localhost:4200/`

### Setting Up the API Token

1. **Get your Phrase JWT token (Recommended ✅):**
   - Log in to [Phrase TMS](https://cloud.memsource.com)
   - Go to **Settings → Access & Security → Access Tokens**
   - Click **Generate New Token**
   - Copy the JWT token

   💡 **Note:** This works even if you signed up with Google/Gmail - no password needed!

2. **Add the token to the application:**
   - Open the application at `http://localhost:4200/`
   - Navigate to **Settings** in the sidebar
   - Paste your JWT token and click **Save Token**

3. **Start using the application:**
   - Go to **Projects** to view all your translation projects
   - Click **Create New Project** to add a new project

---

## Authentication Methods

This app uses **Bearer token authentication** with JWT tokens from Phrase UI.

Alternative methods (not implemented):

- **Token-based auth** (`/auth/login` with username/password) - Returns `ApiToken`
- **OAuth 2.0** - For integrated applications

## API Endpoints

The application uses the following Phrase TMS API endpoints:

- `GET /v1/projects` - List all projects
- `POST /v3/projects` - Create a new project

Base URL: `https://cloud.memsource.com/web/api2`

## Development

### Running the Development Server

```bash
ng serve
```

The application will be available at `http://localhost:4200/` with hot reload enabled.

### Setting Up a Backend Proxy (Recommended)

To handle CORS and secure token management, set up a simple Node.js proxy:

**1. Create a simple proxy server (server.js):**

```javascript
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

app.use(
  "/api/",
  createProxyMiddleware({
    target: "https://cloud.memsource.com/web/api2",
    changeOrigin: true,
    pathRewrite: {
      "^/api": "",
    },
  }),
);

app.listen(3000, () => {
  console.log("Proxy server running on http://localhost:3000");
});
```

**2. Install dependencies:**

```bash
npm install express http-proxy-middleware
```

**3. Run the proxy:**

```bash
node server.js
```

**4. Update environment.ts:**

```typescript
phraseApiBaseUrl: "http://localhost:3000/api";
```

**5. In your browser, open:** `http://localhost:4200`

This approach keeps your API token on the backend where it's secure.

### Building for Production

```bash
ng build
```

Build artifacts will be stored in the `dist/` directory.

### Code Scaffolding

Generate new components:

```bash
ng generate component component-name
```

### Running Tests

```bash
ng test
```

## Configuration

### Environment Variables

Edit `src/environments/environment.ts`:

```typescript
export const environment = {
  production: false,
  phraseApiBaseUrl: "https://cloud.memsource.com/web/api2",
  phraseApiToken: "", // Managed via Settings page
};
```

### Styling

Global styles use CSS custom properties defined in `src/styles.scss`:

- `--primary-color`: Main accent color (#5C6BC0)
- `--text-primary`: Primary text color
- `--background-main`: Main background color
- And more...

Customize these variables to change the application theme.

## API Usage Examples

### Creating a Project

The application creates projects with this payload structure:

```json
{
  "name": "My Translation Project",
  "sourceLang": "en",
  "targetLangs": ["de", "fr", "es"],
  "purchaseOrder": "PO-12345",
  "dateDue": "2026-12-31T23:59:59.000Z",
  "note": "Project notes",
  "fileHandover": true
}
```

### Language Codes

Use ISO 639-1 codes for languages:

- `en` - English
- `de` - German
- `fr` - French
- `es` - Spanish
- `ja` - Japanese
- etc.

## Troubleshooting

### API Authentication Errors

If you receive **401 Unauthorized** errors:

1. **Regenerate your token:** Go to Phrase Settings → Access Tokens → Generate New Token
2. **Verify token format:** Should be a JWT (long string starting with `eyJ...`)
3. **Check token permissions:** Ensure it has access to projects
4. **Try re-saving:** Delete token in Settings, paste fresh token, and save again

**Note:** JWT tokens from Phrase UI use `Bearer` authentication (not `ApiToken`).

### No Projects Displayed

If the projects list is empty:

1. Verify you have projects in your Phrase account
2. Check the browser console for API errors
3. Ensure your API token has permission to view projects

### CORS Errors

If you encounter **CORS policy errors** (blocked XMLHttpRequest), this is a browser security restriction. The Phrase API doesn't allow direct requests from browsers.

**Solutions:**

**Option 1: Use a Backend Proxy (Recommended for Production)**

- Deploy a backend service that proxies requests to Phrase API
- Have the Angular app call your backend instead of the external API
- The backend handles CORS and token security

**Option 2: Use a CORS Proxy for Development**

- Temporarily use a CORS proxy service like:
  - `https://cors-anywhere.herokuapp.com/` (requires activation)
  - `https://api.allorigins.win/` (simple passthrough)
- Update `environment.ts` temporarily:
  ```typescript
  phraseApiBaseUrl: "https://cors-anywhere.herokuapp.com/https://cloud.memsource.com/web/api2";
  ```
- ⚠️ Only for development - never use in production

**Option 3: Configure Local Angular Proxy** (requires proxy.conf.json)

- Create a proxy configuration for `ng serve`
- Forward `/web/api2` requests to `https://cloud.memsource.com`
- See proxy.conf.json example in the project

**Best Practice:**
For production, create a Node.js/Express backend service that:

1. Accepts API requests from your Angular app
2. Forwards them to Phrase API with proper CORS headers
3. Securely manages API tokens (never expose in frontend code)

## Security Notes

⚠️ **This is a non-production application**

- API tokens are stored in `localStorage` (not secure for production)
- For production use, implement proper authentication and token management
- Never commit API tokens to version control
- Consider using environment-specific configurations

## License

This project is for development and demonstration purposes.

## Support

For Phrase TMS API documentation, visit:

- [Phrase API Documentation](https://cloud.memsource.com/web/docs/api)
- [Phrase Help Center](https://support.phrase.com/)

## Additional Resources

- [Angular Documentation](https://angular.dev)
- [Angular CLI Reference](https://angular.dev/tools/cli)
- [Phrase TMS](https://phrase.com/)
