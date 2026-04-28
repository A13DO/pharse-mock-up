# AI DOCX Translation - Installation

Write-Host "Installing required packages for AI DOCX Translation..." -ForegroundColor Cyan
Write-Host ""

# Install runtime dependencies
Write-Host "Installing mammoth and docx..." -ForegroundColor Yellow
npm install mammoth docx

# Install dev dependencies (types)
Write-Host ""
Write-Host "Installing TypeScript types..." -ForegroundColor Yellow
npm install --save-dev @types/mammoth

Write-Host ""
Write-Host "✓ Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Start the dev server: npm start" -ForegroundColor White
Write-Host "2. Navigate to: http://localhost:4200/ai-translate" -ForegroundColor White
Write-Host "3. Get API keys from:" -ForegroundColor White
Write-Host "   - Anthropic: https://console.anthropic.com/" -ForegroundColor Gray
Write-Host "   - OpenAI: https://platform.openai.com/api-keys" -ForegroundColor Gray
Write-Host "   - Google: https://aistudio.google.com/app/apikey" -ForegroundColor Gray
Write-Host ""
Write-Host "For detailed documentation, see: AI_DOCX_TRANSLATION.md" -ForegroundColor Cyan
