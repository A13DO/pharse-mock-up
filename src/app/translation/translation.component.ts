import { Component, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DocxTranslationService,
  Provider,
} from '../services/docx-translation.service';

interface ModelOption {
  id: string;
  name: string;
  description: string;
}

interface ProviderInfo {
  id: Provider;
  name: string;
  model: string;
  color: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyUrl: string;
  freeTier?: boolean;
  models: ModelOption[];
}

type ProgressStep =
  | 'idle'
  | 'reading'
  | 'translating'
  | 'building'
  | 'complete';

type WorkflowStep = 1 | 2 | 3;

@Component({
  selector: 'app-translation',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './translation.component.html',
  styleUrls: ['./translation.component.scss'],
})
export class TranslationComponent {
  // Providers configuration
  providers: ProviderInfo[] = [
    {
      id: 'anthropic',
      name: 'Anthropic Claude',
      model: 'claude-opus-4-20250514',
      color: '#c96442',
      keyLabel: 'Anthropic API Key',
      keyPlaceholder: 'sk-ant-...',
      keyUrl: 'https://console.anthropic.com',
      freeTier: false,
      models: [
        {
          id: 'claude-opus-4-20250514',
          name: 'Claude Opus 4',
          description: 'Most capable',
        },
        {
          id: 'claude-sonnet-4-20250514',
          name: 'Claude Sonnet 4',
          description: 'Fast & cost-effective',
        },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI ChatGPT',
      model: 'gpt-4o',
      color: '#10a37f',
      keyLabel: 'OpenAI API Key',
      keyPlaceholder: 'sk-proj-...',
      keyUrl: 'https://platform.openai.com/api-keys',
      freeTier: false,
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          description: 'Most capable, multimodal',
        },
        {
          id: 'gpt-4o-mini',
          name: 'GPT-4o Mini',
          description: 'Fast & budget-friendly',
        },
        {
          id: 'gpt-4-turbo',
          name: 'GPT-4 Turbo',
          description: 'High quality, reliable',
        },
      ],
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      model: 'gemini-1.5-pro',
      color: '#4285f4',
      keyLabel: 'Google AI Studio Key',
      keyPlaceholder: 'AIza...',
      keyUrl: 'https://aistudio.google.com/apikey',
      freeTier: true,
      models: [
        {
          id: 'gemini-1.5-pro',
          name: 'Gemini 1.5 Pro',
          description: 'Best quality',
        },
        {
          id: 'gemini-1.5-flash',
          name: 'Gemini 1.5 Flash',
          description: 'Fast & free',
        },
        {
          id: 'gemini-2.0-flash-exp',
          name: 'Gemini 2.0 Flash',
          description: 'Experimental',
        },
      ],
    },
    {
      id: 'groq',
      name: 'Groq',
      model: 'llama-3.3-70b-versatile',
      color: '#f55036',
      keyLabel: 'Groq API Key',
      keyPlaceholder: 'gsk_...',
      keyUrl: 'https://console.groq.com',
      freeTier: true,
      models: [
        {
          id: 'llama-3.3-70b-versatile',
          name: 'Llama 3.3 70B',
          description: 'Best quality, free',
        },
        {
          id: 'llama-3.1-8b-instant',
          name: 'Llama 3.1 8B',
          description: 'Ultra-fast, free',
        },
        {
          id: 'mixtral-8x7b-32768',
          name: 'Mixtral 8x7B',
          description: 'Long context, free',
        },
      ],
    },
  ];

  // Base term extraction prompt - used in Step 1
  baseTermPrompt = `You are a professional linguistic analyst and terminology specialist.
## Task Context
You will receive text extracted from a document.
The extraction MUST follow the file metadata:
- Source Language: English
- Target Language: Arabic
You MUST extract terminology based on the source language and provide the required translation in the target language.
---
## Task
Extract and create a TermBase table with the following columns:
# | Source Term (English) | REQUIRED Translation (Arabic) | Category
Number each row starting from 1.
---
## Extraction Scope (STRICT)
You MUST extract ONLY the following types of terms:
1. Company names (اسماء الشركات)
2. People names (الاشخاص)
3. Abbreviations (الاختصارات)
4. Main key terms (المصطلحات الرئيسية في الملف)
---
## Rules
- Extract terms EXACTLY as they appear in the source text
- Do NOT modify or normalize source terms
- Provide accurate and professional translations in Arabic
- Use consistent translation for repeated terms
- Do NOT include duplicates (same term more than once)
- Do NOT include irrelevant words
---
## Category Rules
Assign ONE category per term:
- Company names (اسماء الشركات)
- People names (الاشخاص)
- Abbreviations (الاختصارات)
- Main key terms (المصطلحات الرئيسية في الملف)
---
## Output Format (STRICT)
You MUST output a table with EXACTLY 4 columns:
| # | Source Term (English) | REQUIRED Translation (Arabic) | Category |`;

  // Default translation prompt for Step 2
  defaultTranslationPrompt = `You are a highly experienced professional translator with broad expertise across multiple domains, specializing in English to Arabic translation.

## Task Context
You will receive text segments in numbered cells extracted from a document.

The file is part of a translation workflow. You MUST:
* Perform translation according to the project metadata (domain, tone, and context if provided).
* Follow the translation instructions strictly.
* Ensure the output is suitable for localization workflows (e.g., Phrase integration).
* If metadata is provided (legal, technical, marketing, etc.), adapt tone accordingly.

---

## ⚠️ TERMINOLOGY COMPLIANCE — HIGHEST PRIORITY ⚠️

This is the MOST CRITICAL requirement. You MUST follow the terminology glossary as specified. This is NON-NEGOTIABLE.

**MANDATORY RULES FOR TERMINOLOGY:**
* When a source term from the glossary appears in the source text, you MUST use the corresponding translation EXACTLY.
* No synonyms, no alternatives, no variations.
* This applies to EVERY occurrence.
* If repeated → same translation EVERY time.
* Glossary OVERRIDES your preferences.

**CAPITALIZATION RULES:**
* Apply natural Arabic usage.
* Proper nouns must remain consistent.

---

## 📋 MANDATORY TERMINOLOGY GLOSSARY

| # | Source Term (English) | REQUIRED Translation (Arabic) | Category |
|---|---|---|---|
| 1 | Example Term | مثال | Company names (اسماء الشركات) |

**REMINDER: Every term above MUST appear in your translation exactly as specified whenever the source term appears in the source text.**

---

## Translation Process (VERY IMPORTANT)

For EACH cell, you MUST produce TWO translations:

### 1) Initial Translation (Draft)
* Accurate, complete translation
* May be slightly literal
* MUST respect glossary strictly

### 2) Final Translation (Post-Edited)
* Fully refined, natural, and idiomatic Arabic
* Professionally rewritten if needed
* Improved flow and readability
* MUST strictly respect glossary terms
* This is the FINAL version to be used in production

🚨 The FINAL translation (Column 4) is the one that will be exported to Phrase.

---

## Other Critical Rules

### 1. COMPLETE TRANSLATION
Translate EVERYTHING. No skipping.

### 2. NO MODIFICATIONS
Do NOT add/remove meaning.

### 3. PRESERVE TAGS
Keep ALL placeholders exactly:
{1}, <1>, </1>, etc.

### 4. MAINTAIN FORMATTING
Keep structure exactly as-is.

### 5. PROFESSIONAL + NATURAL ARABIC
* Avoid literal translation
* Use fluent, native Arabic
* Restructure if needed

---

## Output Format (STRICT)

You MUST output a table with EXACTLY 4 columns:

| Cell # | Source | Initial Translation | Final Translation |

Rules:
* Do NOT merge cells
* Do NOT skip cells
* Keep numbering EXACT

---

## Important Note for Integration

* The "Final Translation" column is the ONLY column that should be used for export to Phrase.
* Ensure it is clean, polished, and production-ready.

---

## Delivery

* Translate all cells provided in each batch
* Maintain consistency across batches`;

  // Quick prompt examples
  quickPrompts = [
    'Extract and create a TermBase table with columns: # | Source Term (English) | REQUIRED Translation (Arabic) | Category. Number each row starting from 1. Extract specifically: Company names (اسماء الشركات), People names (الاشخاص), Abbreviations (الاختصارات), and Main key terms (المصطلحات الرئيسية في الملف). Use appropriate category for each term.',
    'Translate this document to Spanish while maintaining professional tone and technical accuracy.',
    'Translate to French. Keep all proper nouns and brand names unchanged.',
    'Translate to German. Preserve all formatting, bullet points, and numbered lists exactly.',
    'Translate to Japanese. Use formal language appropriate for business documentation.',
  ];

  // Signals for reactive state
  workflowStep = signal<WorkflowStep>(1);
  baseTermTable = signal<{ headers: string[]; rows: string[][] } | null>(null);
  selectedProvider = signal<Provider>('anthropic');
  selectedModel = signal<string>('claude-opus-4-20250514');
  apiKey = signal<string>('');
  showApiKey = signal<boolean>(false);
  uploadedFile = signal<File | null>(null);
  customPrompt = signal<string>(this.defaultTranslationPrompt);
  progressStep = signal<ProgressStep>('idle');
  errorMessage = signal<string | null>(null);
  translatedBlob = signal<Blob | null>(null);
  translatedFilename = signal<string>('');
  originalFileType = signal<'docx' | 'mxliff' | null>(null);
  isDragging = signal<boolean>(false);
  filePreview = signal<string>('');
  showPreview = signal<boolean>(false);
  aiResponse = signal<string>('');
  termBaseTable = signal<{ headers: string[]; rows: string[][] } | null>(null);
  showTermBaseTable = signal<boolean>(false);
  termBaseViewMode = signal<'table' | 'text'>('table');
  showPromptPreview = signal<boolean>(false);

  // Computed prompt with actual extracted TermBase table applied
  finalPrompt = computed(() => {
    let prompt = this.customPrompt();

    // In Step 2, replace the placeholder glossary table with the actual extracted table
    if (this.baseTermTable() && this.workflowStep() === 2) {
      const actualTableText = this.getBaseTermTableAsText();

      // Replace the placeholder table section (from "| # | Source Term" until "**REMINDER:")
      // This pattern matches the header and all rows until the reminder line
      const placeholderPattern =
        /\|\s*#\s*\|\s*Source Term[^\n]*\n[^\n]*\|[^\n]*\n[\s\S]*?(\n\*\*REMINDER:)/;

      if (placeholderPattern.test(prompt)) {
        prompt = prompt.replace(
          placeholderPattern,
          `${actualTableText}\n\n**REMINDER:`,
        );
      }
    }

    return prompt;
  });

  // Computed values
  selectedProviderInfo = computed(() =>
    this.providers.find((p) => p.id === this.selectedProvider()),
  );

  canTranslate = computed(() => {
    const step = this.workflowStep();
    const isIdle = this.progressStep() === 'idle';

    if (step === 1) {
      // Step 1: Just need file and API key (uses baseterm prompt)
      return (
        this.uploadedFile() !== null && this.apiKey().trim() !== '' && isIdle
      );
    } else if (step === 2) {
      // Step 2: Need file, custom prompt, API key, and baseterm table from step 1
      return (
        this.uploadedFile() !== null &&
        this.customPrompt().trim() !== '' &&
        this.apiKey().trim() !== '' &&
        this.baseTermTable() !== null &&
        isIdle
      );
    }
    return false;
  });

  isProcessing = computed(() => {
    const step = this.progressStep();
    return step === 'reading' || step === 'translating' || step === 'building';
  });

  fileInfo = computed(() => {
    const file = this.uploadedFile();
    if (!file) return null;
    return {
      name: file.name,
      size: this.formatFileSize(file.size),
    };
  });

  progressMessage = computed(() => {
    switch (this.progressStep()) {
      case 'reading':
        return 'Reading document...';
      case 'translating':
        return 'Translating with AI...';
      case 'building':
        return 'Building DOCX file...';
      case 'complete':
        return 'Translation complete!';
      default:
        return '';
    }
  });

  private docxService = inject(DocxTranslationService);

  constructor() {
    this.loadApiKeys();
    const savedModel = localStorage.getItem(
      `docx_ai_model_${this.selectedProvider()}`,
    );
    const info = this.providers.find((p) => p.id === this.selectedProvider());
    this.selectedModel.set(savedModel || info?.model || '');
  }

  /**
   * Select a provider and load its saved API key
   */
  selectProvider(provider: Provider): void {
    this.selectedProvider.set(provider);
    this.loadApiKey(provider);
    const savedModel = localStorage.getItem(`docx_ai_model_${provider}`);
    const info = this.providers.find((p) => p.id === provider);
    this.selectedModel.set(savedModel || info?.model || '');
  }

  selectModel(modelId: string): void {
    this.selectedModel.set(modelId);
    localStorage.setItem(`docx_ai_model_${this.selectedProvider()}`, modelId);
  }

  /**
   * Save API key to localStorage
   */
  saveApiKey(): void {
    const provider = this.selectedProvider();
    const key = this.apiKey().trim();

    if (key) {
      localStorage.setItem(`docx_ai_key_${provider}`, key);
      console.log('✅ API key saved for', provider);
    }
  }

  /**
   * Load API key from localStorage for the current provider
   */
  private loadApiKey(provider: Provider): void {
    const savedKey = localStorage.getItem(`docx_ai_key_${provider}`) || '';
    this.apiKey.set(savedKey);
  }

  /**
   * Load all API keys on component init
   */
  private loadApiKeys(): void {
    this.loadApiKey(this.selectedProvider());
  }

  /**
   * Toggle API key visibility
   */
  toggleApiKeyVisibility(): void {
    this.showApiKey.set(!this.showApiKey());
  }

  /**
   * Handle file selection via input
   */
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.handleFile(input.files[0]);
    }
  }

  /**
   * Handle drag over event
   */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  /**
   * Handle drag leave event
   */
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  /**
   * Handle file drop
   */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      this.handleFile(event.dataTransfer.files[0]);
    }
  }

  /**
   * Validate and set the uploaded file
   */
  private async handleFile(file: File): Promise<void> {
    const fileName = file.name.toLowerCase();
    const validExtensions = ['.docx', '.mxliff', '.xliff', '.xml'];
    const isValid = validExtensions.some((ext) => fileName.endsWith(ext));

    if (!isValid) {
      this.errorMessage.set('Please upload a .docx or .mxliff file');
      return;
    }

    this.uploadedFile.set(file);
    this.errorMessage.set(null);
    console.log('📎 File uploaded:', file.name);

    // Extract and preview file content
    await this.extractAndPreviewFile(file);
  }

  /**
   * Extract and preview file content
   */
  private async extractAndPreviewFile(file: File): Promise<void> {
    try {
      const extractedText = await this.docxService.extractTextFromFile(file);

      // Limit preview to first 2000 characters to keep UI responsive
      const previewText =
        extractedText.length > 2000
          ? extractedText.substring(0, 2000) + '...'
          : extractedText;

      this.filePreview.set(previewText);
      this.showPreview.set(true);
      console.log('✅ File preview ready:', extractedText.length, 'chars');
    } catch (error: any) {
      console.error('❌ Preview extraction failed:', error);
      this.errorMessage.set(`Failed to extract file content: ${error.message}`);
      this.filePreview.set('');
      this.showPreview.set(false);
    }
  }

  /**
   * Toggle preview visibility
   */
  togglePreview(): void {
    this.showPreview.set(!this.showPreview());
  }

  /**
   * Toggle TermBase table visibility
   */
  toggleTermBaseTable(): void {
    this.showTermBaseTable.set(!this.showTermBaseTable());
  }

  /**
   * Update a cell value in the baseTermTable (Step 2 reference)
   * @param rowIndex - Row index in the table
   * @param colIndex - Column index in the table
   * @param newValue - New cell value
   */
  updateBaseTermTableCell(
    rowIndex: number,
    colIndex: number,
    newValue: string,
  ): void {
    const table = this.baseTermTable();
    if (!table) return;

    // Create a new copy of the table data (immutable update)
    const updatedRows = [...table.rows];
    updatedRows[rowIndex] = [...updatedRows[rowIndex]];
    updatedRows[rowIndex][colIndex] = newValue;

    this.baseTermTable.set({
      headers: table.headers,
      rows: updatedRows,
    });

    console.log('✏️ BaseTermTable cell updated:', rowIndex, colIndex, newValue);
  }

  /**
   * Update a cell value in the TermBase table
   * @param rowIndex - Row index in the table
   * @param colIndex - Column index in the table
   * @param newValue - New cell value
   */
  updateTableCell(rowIndex: number, colIndex: number, newValue: string): void {
    const table = this.termBaseTable();
    if (!table) return;

    // Create a new copy of the table data (immutable update)
    const updatedRows = [...table.rows];
    updatedRows[rowIndex] = [...updatedRows[rowIndex]];
    updatedRows[rowIndex][colIndex] = newValue;

    this.termBaseTable.set({
      headers: table.headers,
      rows: updatedRows,
    });

    console.log('✏️ Cell updated:', rowIndex, colIndex, newValue);
  }

  /**
   * Toggle between table and text view
   */
  toggleTermBaseViewMode(): void {
    this.termBaseViewMode.set(
      this.termBaseViewMode() === 'table' ? 'text' : 'table',
    );
  }

  /**
   * Generate markdown text representation of the baseTermTable
   */
  getBaseTermTableAsText(): string {
    const table = this.baseTermTable();
    if (!table) return '';

    const lines: string[] = [];

    // Header row
    lines.push('| ' + table.headers.join(' | ') + ' |');

    // Separator row
    lines.push('|' + table.headers.map(() => '---').join('|') + '|');

    // Data rows
    table.rows.forEach((row) => {
      lines.push('| ' + row.join(' | ') + ' |');
    });

    return lines.join('\n');
  }

  /**
   * Generate markdown text representation of the table
   */
  getTableAsText(): string {
    const table = this.termBaseTable();
    if (!table) return '';

    const lines: string[] = [];

    // Header row
    lines.push('| ' + table.headers.join(' | ') + ' |');

    // Separator row
    lines.push('|' + table.headers.map(() => '---').join('|') + '|');

    // Data rows
    table.rows.forEach((row) => {
      lines.push('| ' + row.join(' | ') + ' |');
    });

    return lines.join('\n');
  }

  /**
   * Copy table text to clipboard
   */
  async copyTableText(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.getTableAsText());
      console.log('✅ Table text copied to clipboard');
    } catch (error) {
      console.error('❌ Failed to copy:', error);
      this.errorMessage.set('Failed to copy to clipboard');
    }
  }

  /**
   * Parse markdown table from AI response
   * Supports both pipe-style tables (| col1 | col2 |) and tab-separated values
   */
  private parseMarkdownTable(
    text: string,
  ): { headers: string[]; rows: string[][] } | null {
    const lines = text.split('\n').filter((line) => line.trim());

    // Look for markdown table with | separators
    const tableLines = lines.filter((line) => line.includes('|'));

    if (tableLines.length < 2) {
      // Try TSV format if no markdown table found
      return this.parseTsvTable(text);
    }

    const parseRow = (line: string): string[] => {
      return line
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
    };

    // First line is headers
    const headers = parseRow(tableLines[0]);

    // Skip separator line (usually contains --- )
    const dataLines = tableLines
      .slice(1)
      .filter((line) => !line.match(/^\|?\s*[-:]+\s*\|/));

    if (dataLines.length === 0) {
      return null;
    }

    const rows = dataLines.map((line) => parseRow(line));

    // Validate that all rows have the same number of columns as headers
    const validRows = rows.filter((row) => row.length === headers.length);

    if (validRows.length === 0) {
      return null;
    }

    return { headers, rows: validRows };
  }

  /**
   * Parse tab-separated or comma-separated table
   */
  private parseTsvTable(
    text: string,
  ): { headers: string[]; rows: string[][] } | null {
    const lines = text.split('\n').filter((line) => line.trim());

    if (lines.length < 2) {
      return null;
    }

    // Try tab-separated first, then comma-separated
    const separator = lines[0].includes('\t') ? '\t' : ',';

    const parseRow = (line: string): string[] => {
      return line.split(separator).map((cell) => cell.trim());
    };

    const headers = parseRow(lines[0]);
    const rows = lines.slice(1).map((line) => parseRow(line));

    // Validate
    const validRows = rows.filter((row) => row.length === headers.length);

    if (validRows.length === 0) {
      return null;
    }

    return { headers, rows: validRows };
  }

  /**
   * Use a quick prompt example
   */
  useQuickPrompt(prompt: string): void {
    this.customPrompt.set(prompt);
  }

  /**
   * Move to next workflow step
   */
  nextStep(): void {
    if (this.workflowStep() < 3) {
      this.workflowStep.set(
        ((this.workflowStep() as number) + 1) as WorkflowStep,
      );
      this.uploadedFile.set(null);
      this.filePreview.set('');
      this.showPreview.set(false);
      this.errorMessage.set(null);
    }
  }

  /**
   * Move to previous workflow step
   */
  previousStep(): void {
    if (this.workflowStep() > 1) {
      this.workflowStep.set(
        ((this.workflowStep() as number) - 1) as WorkflowStep,
      );
      this.uploadedFile.set(null);
      this.filePreview.set('');
      this.showPreview.set(false);
      this.customPrompt.set('');
      this.errorMessage.set(null);
    }
  }

  /**
   * Reset workflow to step 1
   */
  resetWorkflow(): void {
    this.workflowStep.set(1);
    this.uploadedFile.set(null);
    this.customPrompt.set('');
    this.progressStep.set('idle');
    this.errorMessage.set(null);
    this.translatedBlob.set(null);
    this.translatedFilename.set('');
    this.originalFileType.set(null);
    this.filePreview.set('');
    this.showPreview.set(false);
    this.aiResponse.set('');
    this.termBaseTable.set(null);
    this.showTermBaseTable.set(false);
    this.termBaseViewMode.set('table');
    this.baseTermTable.set(null);
  }

  /**
   * Start the translation process (handles both step 1 and step 2)
   */
  async translate(): Promise<void> {
    if (!this.canTranslate()) return;

    const file = this.uploadedFile();
    const provider = this.selectedProvider();
    const apiKey = this.apiKey();
    const step = this.workflowStep();

    if (!file) return;

    this.errorMessage.set(null);
    this.translatedBlob.set(null);
    this.progressStep.set('reading');

    try {
      setTimeout(() => this.progressStep.set('translating'), 500);

      // Determine which prompt to use based on step
      let prompt = '';
      if (step === 1) {
        // Step 1: Use baseterm extraction prompt
        prompt = this.baseTermPrompt;
      } else if (step === 2) {
        // Step 2: Use the final prompt with actual TermBase table embedded
        prompt = this.finalPrompt();
      }

      const result = await this.docxService.translateDocument(
        file,
        prompt,
        provider,
        apiKey,
        this.selectedModel(),
      );

      // Store the original file type for later use in download
      this.originalFileType.set(result.fileType);

      this.progressStep.set('building');

      // Store AI response and parse table if present
      this.aiResponse.set(result.responseText);
      const tableData = this.parseMarkdownTable(result.responseText);

      if (tableData) {
        if (step === 1) {
          // Step 1: Store baseterm table and move to step 2
          this.baseTermTable.set(tableData);
          this.showTermBaseTable.set(true);
          console.log(
            '✅ TermBase table extracted:',
            tableData.headers.length,
            'columns,',
            tableData.rows.length,
            'rows',
          );

          // Auto-move to step 2
          setTimeout(() => {
            this.progressStep.set('idle');
            this.nextStep();
          }, 1000);
        } else if (step === 2) {
          // Step 2: Store result table for download
          this.termBaseTable.set(tableData);
          this.showTermBaseTable.set(true);
          console.log(
            '✅ Translation table generated:',
            tableData.headers.length,
            'columns,',
            tableData.rows.length,
            'rows',
          );

          // Show success state and advance to step 3
          setTimeout(() => {
            this.translatedBlob.set(result.blob);
            this.translatedFilename.set(result.filename);
            this.progressStep.set('complete');
            this.nextStep(); // Advance to Step 3
          }, 500);
        }
      } else if (step === 2) {
        // Step 2 without table result - still advance to step 3
        this.translatedBlob.set(result.blob);
        this.translatedFilename.set(result.filename);
        this.progressStep.set('complete');
        this.nextStep(); // Advance to Step 3
      }
    } catch (error: any) {
      console.error('❌ Translation failed:', error);
      this.errorMessage.set(error.message || 'Translation failed');
      this.progressStep.set('idle');
    }
  }

  /**
   * Download the translated document
   * For DOCX files with TermBase table: inject "Final Translation" column back into original DOCX structure
   * This preserves Phrase bilingual format with SDTs and segment IDs
   */
  async downloadTranslation(): Promise<void> {
    const table = this.termBaseTable();
    let filename = this.translatedFilename();
    const fileType = this.originalFileType();

    if (!filename) return;

    try {
      let blob: Blob;

      // If we have a table with translations, inject them into the original file structure
      if (
        table &&
        table.headers.length > 0 &&
        table.rows.length > 0 &&
        fileType
      ) {
        console.log(
          '📊 Injecting translations into original',
          fileType.toUpperCase(),
          'structure...',
        );

        // Find the "Final Translation" column index (should be column 3 or named "Final Translation")
        const finalTranslationColIndex =
          table.headers.findIndex(
            (h) =>
              h.toLowerCase().includes('final translation') ||
              h.toLowerCase().includes('final trans'),
          ) || 3; // Default to column index 3 if not found by name

        console.log(
          '   📍 Final Translation column index:',
          finalTranslationColIndex,
        );
        console.log('   📊 Total rows to inject:', table.rows.length);

        if (fileType === 'docx') {
          // Extract segment IDs and source text from original DOCX
          const segments = await this.docxService.extractSegmentsWithIds();
          console.log(
            '   📊 Segments found in original DOCX:',
            segments.length,
          );
          console.log('   📊 Table rows available:', table.rows.length);

          // Validate that we have the same number of segments and table rows
          if (segments.length !== table.rows.length) {
            console.warn(`⚠️ WARNING: Segment count mismatch!`);
            console.warn(`   Segments in DOCX: ${segments.length}`);
            console.warn(`   Rows in table: ${table.rows.length}`);
            console.warn(`   This may cause incorrect mappings!`);
          }

          // Log first few segments and table rows for debugging
          console.log('   📄 First 3 segments from DOCX:');
          segments.slice(0, 3).forEach((seg, i) => {
            console.log(
              `      ${i + 1}. [${seg.id}] ${seg.sourceText.substring(0, 60)}...`,
            );
          });

          console.log('   📄 First 3 table rows:');
          table.rows.slice(0, 3).forEach((row, i) => {
            console.log(
              `      ${i + 1}. Source: ${row[1]?.substring(0, 60)}... → Final: ${row[finalTranslationColIndex]?.substring(0, 60)}...`,
            );
          });

          // Map translations to segment IDs
          // The table row index should match the segment number
          const translations = segments
            .map((segment, index) => {
              // Get the final translation from the table (use row index if available)
              const finalTranslation =
                table.rows[index]?.[finalTranslationColIndex] || '';

              // Validate that source texts match (for debugging)
              const tableSourceText = table.rows[index]?.[1] || ''; // Column 1 is "Source"
              if (tableSourceText !== segment.sourceText) {
                console.warn(`⚠️ Source text mismatch at row ${index + 1}:`);
                console.warn(
                  `   Segment: "${segment.sourceText.substring(0, 50)}..."`,
                );
                console.warn(
                  `   Table:   "${tableSourceText.substring(0, 50)}..."`,
                );
              }

              return {
                segmentId: segment.id,
                targetText: finalTranslation,
              };
            })
            .filter((t) => t.targetText.trim() !== ''); // Only include non-empty translations

          console.log('   ✅ Translations prepared:', translations.length);
          if (translations.length > 0) {
            console.log('   📄 First 3 translations to inject:');
            translations.slice(0, 3).forEach((t, i) => {
              console.log(
                `      ${i + 1}. [${t.segmentId}] → "${t.targetText.substring(0, 60)}..."`,
              );
            });
          }

          // Inject translations into the original DOCX structure
          blob =
            await this.docxService.injectTranslationsAndBuild(translations);

          // Update filename to indicate it's ready for Phrase upload
          filename = filename.replace('_translated_', '_ready_for_phrase_');

          console.log(
            '   ✅ DOCX injection complete! File preserves Phrase bilingual structure.',
          );
        } else if (fileType === 'mxliff') {
          // Extract segment IDs from MXLIFF
          const segments = await this.docxService.extractSegmentsFromMxliff();
          console.log(
            '   📊 Segments found in original MXLIFF:',
            segments.length,
          );

          // Map translations to segment IDs
          const translations = segments
            .map((segment, index) => {
              const finalTranslation =
                table.rows[index]?.[finalTranslationColIndex] || '';

              return {
                segmentId: segment.id,
                targetText: finalTranslation,
              };
            })
            .filter((t) => t.targetText.trim() !== '');

          console.log('   ✅ Translations prepared:', translations.length);

          // Inject translations into MXLIFF
          blob =
            await this.docxService.injectTranslationsIntoMxliff(translations);

          // Change extension to .mxliff for proper file format
          filename = filename
            .replace('.docx', '.mxliff')
            .replace('_translated_', '_ready_for_phrase_');

          console.log('   ✅ MXLIFF injection complete!');
        } else {
          // Fallback: build simple table DOCX
          console.warn('⚠️ Unknown file type, building simple table DOCX');
          blob = await this.docxService.buildDocxFromTable(
            table.headers,
            table.rows,
            filename,
          );
        }
      } else {
        // Use the original blob (no table or file type info)
        const originalBlob = this.translatedBlob();
        if (!originalBlob) return;
        blob = originalBlob;
        console.log('📄 Using original blob (no table injection needed)');
      }

      // Trigger download
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      console.log('✅ Download complete');
    } catch (error: any) {
      console.error('❌ Download failed:', error);
      this.errorMessage.set(`Download failed: ${error.message}`);
    }
  }

  /**
   * Reset the component state
   */
  reset(): void {
    this.uploadedFile.set(null);
    this.customPrompt.set('');
    this.progressStep.set('idle');
    this.errorMessage.set(null);
    this.translatedBlob.set(null);
    this.translatedFilename.set('');
    this.originalFileType.set(null);
    this.filePreview.set('');
    this.showPreview.set(false);
    this.aiResponse.set('');
    this.termBaseTable.set(null);
    this.showTermBaseTable.set(false);
    this.termBaseViewMode.set('table');
    this.baseTermTable.set(null);
  }

  /**
   * Format file size for display
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}
