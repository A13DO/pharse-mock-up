import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HeaderComponent } from '../../layout/header/header.component';
import { PhraseApiService, Job } from '../../core/services/phrase-api.service';
import {
  DocxTranslationService,
  Provider,
} from '../../services/docx-translation.service';

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
  imports: [CommonModule, RouterModule, FormsModule, HeaderComponent],
  templateUrl: './translation.component.html',
  styleUrl: './translation.component.scss',
})
export class TranslationComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private phraseApi = inject(PhraseApiService);
  private docxService = inject(DocxTranslationService);

  // Route params
  projectUid: string | null = null;
  jobUid: string | null = null;
  job: Job | null = null;

  // Loading states
  loading = false;
  error: string | null = null;
  successMessage: string | null = null;
  isDownloadingFile = false;

  // File state
  originalFile: File | null = null;

  // Workflow state (signals)
  workflowStep = signal<WorkflowStep>(1);
  progressStep = signal<ProgressStep>('idle');
  baseTermTable = signal<{ headers: string[]; rows: string[][] } | null>(null);
  termBaseTable = signal<{ headers: string[]; rows: string[][] } | null>(null);
  selectedProvider = signal<Provider>('anthropic');
  selectedModel = signal<string>('claude-opus-4-20250514');
  apiKey = signal<string>('');
  showApiKey = signal<boolean>(false);
  customPrompt = signal<string>('');
  errorMessage = signal<string | null>(null);
  translatedBlob = signal<Blob | null>(null);
  translatedFilename = signal<string>('');
  filePreview = signal<string>('');
  showPreview = signal<boolean>(false);
  aiResponse = signal<string>('');
  showTermBaseTable = signal<boolean>(false);
  termBaseViewMode = signal<'table' | 'text'>('table');
  showPromptPreview = signal<boolean>(false);
  isUploading = signal<boolean>(false);
  uploadSuccess = signal<boolean>(false);
  uploadMessage = signal<string | null>(null);

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

  // Base term extraction prompt - used in Step 1 (editable)
  baseTermPrompt =
    signal<string>(`You are a professional linguistic analyst and terminology specialist.
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
| # | Source Term (English) | REQUIRED Translation (Arabic) | Category |`);

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
    'Extract and create a TermBase table with columns: # | Source Term (English) | REQUIRED Translation (Arabic) | Category. Number each row starting from 1.',
    'Translate this document to Spanish while maintaining professional tone and technical accuracy.',
    'Translate to French. Keep all proper nouns and brand names unchanged.',
    'Translate to German. Preserve all formatting, bullet points, and numbered lists exactly.',
  ];

  // Computed values
  selectedProviderInfo = computed(() =>
    this.providers.find((p) => p.id === this.selectedProvider()),
  );

  // Final prompt with actual extracted TermBase table applied
  finalPrompt = computed(() => {
    const prompt = this.customPrompt();
    const table = this.baseTermTable();

    if (!table || table.rows.length === 0) {
      return prompt;
    }

    // Convert table to markdown text
    const actualTableText = this.getBaseTermTableAsText();

    // Find and replace the placeholder glossary section
    const pattern =
      /\|\s*#\s*\|\s*Source Term[^\n]*\n[^\n]*\|[^\n]*\n[\s\S]*?(\n\*\*REMINDER:)/;

    if (pattern.test(prompt)) {
      return prompt.replace(pattern, `${actualTableText}\n\n**REMINDER:`);
    }

    return prompt;
  });

  canTranslate = computed(() => {
    const apiKey = this.apiKey().trim();
    const file = this.originalFile;
    const step = this.workflowStep();
    const isIdle = this.progressStep() === 'idle';

    if (!apiKey || !file || !isIdle) return false;

    if (step === 1) return true;
    if (step === 2 && this.baseTermTable()) return true;

    return false;
  });

  isProcessing = computed(() => {
    return ['reading', 'translating', 'building'].includes(this.progressStep());
  });

  fileInfo = computed(() => {
    const file = this.originalFile;
    if (!file) return null;
    return {
      name: file.name,
      size: this.formatFileSize(file.size),
    };
  });

  progressMessage = computed(() => {
    switch (this.progressStep()) {
      case 'reading':
        return 'Reading file...';
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

  ngOnInit(): void {
    this.projectUid = this.route.snapshot.paramMap.get('projectUid');
    this.jobUid = this.route.snapshot.paramMap.get('jobUid');

    if (!this.projectUid || !this.jobUid) {
      this.error = 'Missing project or job identifier';
      return;
    }

    this.loadSavedSettings();
    this.loadJobDetails();
    this.customPrompt.set(this.defaultTranslationPrompt);
  }

  private loadSavedSettings(): void {
    const savedProvider = localStorage.getItem(
      'docx_ai_provider',
    ) as Provider | null;
    if (savedProvider && this.providers.some((p) => p.id === savedProvider)) {
      this.selectedProvider.set(savedProvider);
    }

    const savedModel = localStorage.getItem(
      `docx_ai_model_${this.selectedProvider()}`,
    );
    const info = this.selectedProviderInfo();
    this.selectedModel.set(savedModel || info?.models[0]?.id || '');

    const savedKey =
      localStorage.getItem(`docx_ai_key_${this.selectedProvider()}`) || '';
    this.apiKey.set(savedKey);
  }

  loadJobDetails(): void {
    if (!this.projectUid || !this.jobUid) return;

    this.loading = true;
    this.phraseApi.getJobs(this.projectUid).subscribe({
      next: (response) => {
        this.job = response.content.find((j) => j.uid === this.jobUid) || null;
        this.loading = false;
        if (this.job) {
          // Update prompts with job-specific information
          this.updatePromptsWithJobInfo();
          // Auto-fetch the bilingual file
          this.downloadOriginalFile();
        }
      },
      error: (err) => {
        this.error = err.message;
        this.loading = false;
        console.error('Failed to load job:', err);
      },
    });
  }

  /**
   * Update prompts with job-specific information (target language)
   */
  private updatePromptsWithJobInfo(): void {
    if (!this.job) return;

    const targetLang = this.job.targetLang || 'Target Language';

    // Update base term extraction prompt
    const currentBasePrompt = this.baseTermPrompt();
    const updatedBasePrompt = currentBasePrompt
      .replace(/Target Language: Arabic/g, `Target Language: ${targetLang}`)
      .replace(
        /REQUIRED Translation \(Arabic\)/g,
        `REQUIRED Translation (${targetLang})`,
      )
      .replace(/translations in Arabic/g, `translations in ${targetLang}`);
    this.baseTermPrompt.set(updatedBasePrompt);

    // Update translation prompt
    const currentTranslationPrompt = this.defaultTranslationPrompt;
    const updatedTranslationPrompt = currentTranslationPrompt.replace(
      /English to Arabic translation/g,
      `English to ${targetLang} translation`,
    );
    this.customPrompt.set(updatedTranslationPrompt);

    console.log(`✅ Prompts updated for target language: ${targetLang}`);
  }

  async downloadOriginalFile(): Promise<void> {
    if (
      !this.projectUid ||
      !this.jobUid ||
      this.isDownloadingFile ||
      this.originalFile
    ) {
      return;
    }

    this.isDownloadingFile = true;
    this.error = null;

    try {
      const blob = await this.phraseApi.downloadBilingualFile(
        this.projectUid,
        [this.jobUid],
        'DOCX',
      );

      console.log(
        '📦 Bilingual file blob size:',
        blob.size,
        'bytes | type:',
        blob.type,
      );

      if (blob.size < 10_000) {
        const preview = await blob.text();
        console.warn(
          '⚠️ Small blob content (likely not a valid file):',
          preview,
        );
      }

      const baseName =
        this.job?.filename?.replace(/\.[^.]+$/, '') || 'document';
      const fileName = `${baseName}_bilingual.docx`;

      const mimeType =
        blob.type ||
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      this.originalFile = new File([blob], fileName, { type: mimeType });
      this.isDownloadingFile = false;
      console.log('✅ Bilingual file loaded successfully:', fileName);

      // Extract and preview
      await this.extractAndPreviewFile(this.originalFile);
    } catch (err: any) {
      this.error = err.message || 'Failed to fetch the bilingual job file';
      this.isDownloadingFile = false;
      console.error('Download error:', err);
    }
  }

  private async extractAndPreviewFile(file: File): Promise<void> {
    try {
      const extractedText = await this.docxService.extractTextFromFile(file);
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

  selectProvider(provider: Provider): void {
    this.selectedProvider.set(provider);
    localStorage.setItem('docx_ai_provider', provider);
    const savedModel = localStorage.getItem(`docx_ai_model_${provider}`);
    const info = this.providers.find((p) => p.id === provider);
    this.selectedModel.set(savedModel || info?.models[0]?.id || '');
    const savedKey = localStorage.getItem(`docx_ai_key_${provider}`) || '';
    this.apiKey.set(savedKey);
  }

  selectModel(modelId: string): void {
    this.selectedModel.set(modelId);
    localStorage.setItem(`docx_ai_model_${this.selectedProvider()}`, modelId);
  }

  saveApiKey(): void {
    const provider = this.selectedProvider();
    const key = this.apiKey().trim();
    if (key) {
      localStorage.setItem(`docx_ai_key_${provider}`, key);
    }
  }

  toggleApiKeyVisibility(): void {
    this.showApiKey.set(!this.showApiKey());
  }

  togglePreview(): void {
    this.showPreview.set(!this.showPreview());
  }

  toggleTermBaseTable(): void {
    this.showTermBaseTable.set(!this.showTermBaseTable());
  }

  updateBaseTermTableCell(
    rowIndex: number,
    colIndex: number,
    newValue: string,
  ): void {
    const table = this.baseTermTable();
    if (!table) return;

    const updatedRows = [...table.rows];
    updatedRows[rowIndex] = [...updatedRows[rowIndex]];
    updatedRows[rowIndex][colIndex] = newValue;

    this.baseTermTable.set({
      headers: table.headers,
      rows: updatedRows,
    });

    console.log('✏️ BaseTermTable cell updated:', rowIndex, colIndex, newValue);
  }

  updateTableCell(rowIndex: number, colIndex: number, newValue: string): void {
    const table = this.termBaseTable();
    if (!table) return;

    const updatedRows = [...table.rows];
    updatedRows[rowIndex] = [...updatedRows[rowIndex]];
    updatedRows[rowIndex][colIndex] = newValue;

    this.termBaseTable.set({
      headers: table.headers,
      rows: updatedRows,
    });

    console.log('✏️ Cell updated:', rowIndex, colIndex, newValue);
  }

  toggleTermBaseViewMode(): void {
    this.termBaseViewMode.set(
      this.termBaseViewMode() === 'table' ? 'text' : 'table',
    );
  }

  getBaseTermTableAsText(): string {
    const table = this.baseTermTable();
    if (!table) return '';

    const lines: string[] = [];
    lines.push('| ' + table.headers.join(' | ') + ' |');
    lines.push('|' + table.headers.map(() => '---').join('|') + '|');
    table.rows.forEach((row) => {
      lines.push('| ' + row.join(' | ') + ' |');
    });

    return lines.join('\n');
  }

  getTableAsText(): string {
    const table = this.termBaseTable();
    if (!table) return '';

    const lines: string[] = [];
    lines.push('| ' + table.headers.join(' | ') + ' |');
    lines.push('|' + table.headers.map(() => '---').join('|') + '|');
    table.rows.forEach((row) => {
      lines.push('| ' + row.join(' | ') + ' |');
    });

    return lines.join('\n');
  }

  async copyTableText(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.getTableAsText());
      console.log('✅ Table text copied to clipboard');
    } catch (error) {
      console.error('❌ Failed to copy:', error);
      this.errorMessage.set('Failed to copy to clipboard');
    }
  }

  private parseMarkdownTable(
    text: string,
  ): { headers: string[]; rows: string[][] } | null {
    const lines = text.split('\n').filter((line) => line.trim());
    const tableLines = lines.filter((line) => line.includes('|'));

    if (tableLines.length < 2) {
      return this.parseTsvTable(text);
    }

    const parseRow = (line: string): string[] => {
      return line
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
    };

    const headers = parseRow(tableLines[0]);
    const dataLines = tableLines
      .slice(1)
      .filter((line) => !line.match(/^\|?\s*[-:]+\s*\|/));

    if (dataLines.length === 0) {
      return null;
    }

    const rows = dataLines.map((line) => parseRow(line));
    const validRows = rows.filter((row) => row.length === headers.length);

    if (validRows.length === 0) {
      return null;
    }

    return { headers, rows: validRows };
  }

  private parseTsvTable(
    text: string,
  ): { headers: string[]; rows: string[][] } | null {
    const lines = text.split('\n').filter((line) => line.trim());

    if (lines.length < 2) {
      return null;
    }

    const separator = lines[0].includes('\t') ? '\t' : ',';

    const parseRow = (line: string): string[] => {
      return line.split(separator).map((cell) => cell.trim());
    };

    const headers = parseRow(lines[0]);
    const rows = lines.slice(1).map((line) => parseRow(line));
    const validRows = rows.filter((row) => row.length === headers.length);

    if (validRows.length === 0) {
      return null;
    }

    return { headers, rows: validRows };
  }

  useQuickPrompt(prompt: string): void {
    this.customPrompt.set(prompt);
  }

  nextStep(): void {
    if (this.workflowStep() < 3) {
      this.workflowStep.set(
        ((this.workflowStep() as number) + 1) as WorkflowStep,
      );
      this.errorMessage.set(null);
    }
  }

  previousStep(): void {
    if (this.workflowStep() > 1) {
      this.workflowStep.set(
        ((this.workflowStep() as number) - 1) as WorkflowStep,
      );
      this.customPrompt.set('');
      this.errorMessage.set(null);
    }
  }

  resetWorkflow(): void {
    this.workflowStep.set(1);
    this.customPrompt.set(this.defaultTranslationPrompt);
    this.progressStep.set('idle');
    this.errorMessage.set(null);
    this.translatedBlob.set(null);
    this.translatedFilename.set('');
    this.filePreview.set('');
    this.showPreview.set(false);
    this.aiResponse.set('');
    this.termBaseTable.set(null);
    this.showTermBaseTable.set(false);
    this.termBaseViewMode.set('table');
    this.baseTermTable.set(null);
    this.isUploading.set(false);
    this.uploadSuccess.set(false);
    this.uploadMessage.set(null);
    // Re-download file
    this.originalFile = null;
    this.downloadOriginalFile();
  }

  async translate(): Promise<void> {
    if (!this.canTranslate()) return;

    const file = this.originalFile;
    const provider = this.selectedProvider();
    const apiKey = this.apiKey();
    const step = this.workflowStep();

    if (!file) return;

    this.errorMessage.set(null);
    this.translatedBlob.set(null);
    this.progressStep.set('reading');

    try {
      setTimeout(() => this.progressStep.set('translating'), 500);

      let prompt = '';
      if (step === 1) {
        prompt = this.baseTermPrompt();
      } else if (step === 2) {
        prompt = this.finalPrompt();
      }

      const result = await this.docxService.translateDocument(
        file,
        prompt,
        provider,
        apiKey,
        this.selectedModel(),
      );

      this.progressStep.set('building');

      this.aiResponse.set(result.responseText);
      const tableData = this.parseMarkdownTable(result.responseText);

      if (tableData) {
        if (step === 1) {
          this.baseTermTable.set(tableData);
          this.showTermBaseTable.set(true);
          console.log(
            '✅ TermBase table extracted:',
            tableData.headers.length,
            'columns,',
            tableData.rows.length,
            'rows',
          );

          setTimeout(() => {
            this.progressStep.set('idle');
            this.nextStep();
          }, 1000);
        } else if (step === 2) {
          this.termBaseTable.set(tableData);
          this.showTermBaseTable.set(true);
          console.log(
            '✅ Translation table generated:',
            tableData.headers.length,
            'columns,',
            tableData.rows.length,
            'rows',
          );

          setTimeout(() => {
            this.translatedBlob.set(result.blob);
            // Use the job's original filename
            const jobFilename = this.job?.filename || result.filename;
            this.translatedFilename.set(jobFilename);
            this.progressStep.set('complete');
            this.nextStep();
          }, 500);
        }
      } else if (step === 2) {
        this.translatedBlob.set(result.blob);
        // Use the job's original filename
        const jobFilename = this.job?.filename || result.filename;
        this.translatedFilename.set(jobFilename);
        this.progressStep.set('complete');
        this.nextStep();
      }
    } catch (error: any) {
      console.error('❌ Translation failed:', error);
      this.errorMessage.set(error.message || 'Translation failed');
      this.progressStep.set('idle');
    }
  }

  async downloadTranslation(): Promise<void> {
    const table = this.termBaseTable();
    const filename = this.translatedFilename();

    if (!filename) return;

    try {
      let blob: Blob;

      if (table && table.headers.length > 0 && table.rows.length > 0) {
        console.log('📊 Rebuilding DOCX from edited table data...');
        blob = await this.docxService.buildDocxFromTable(
          table.headers,
          table.rows,
          filename,
        );
      } else {
        const originalBlob = this.translatedBlob();
        if (!originalBlob) return;
        blob = originalBlob;
      }

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

  async uploadToPhrase(): Promise<void> {
    const table = this.termBaseTable();
    const filename = this.translatedFilename();

    if (!filename) {
      this.uploadMessage.set('No file to upload');
      return;
    }

    this.isUploading.set(true);
    this.uploadSuccess.set(false);
    this.uploadMessage.set(null);
    this.errorMessage.set(null);

    try {
      let blob: Blob;

      // Build the file (same logic as download)
      if (table && table.headers.length > 0 && table.rows.length > 0) {
        console.log('📊 Rebuilding DOCX from edited table data for upload...');
        blob = await this.docxService.buildDocxFromTable(
          table.headers,
          table.rows,
          filename,
        );
      } else {
        const originalBlob = this.translatedBlob();
        if (!originalBlob) {
          this.uploadMessage.set('No translation data available');
          this.isUploading.set(false);
          return;
        }
        blob = originalBlob;
      }

      // Create File object for upload
      const file = new File([blob], filename, {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      if (!this.jobUid) {
        this.uploadMessage.set('Job UID is missing');
        this.isUploading.set(false);
        return;
      }

      console.log('📤 Uploading bilingual file to Phrase TMS...');
      await this.phraseApi.uploadBilingualFile(
        this.jobUid,
        file,
        'Confirmed',
        true,
      );

      this.uploadSuccess.set(true);
      this.uploadMessage.set('File uploaded successfully to Phrase TMS!');
      console.log('✅ Upload complete');
    } catch (error: any) {
      console.error('❌ Upload failed:', error);
      this.uploadMessage.set(`Upload failed: ${error.message}`);
      this.errorMessage.set(`Upload failed: ${error.message}`);
      this.isUploading.set(false);
    } finally {
      this.isUploading.set(false);
    }
  }

  goBack(): void {
    if (this.projectUid) {
      this.router.navigate(['/projects', this.projectUid]);
    } else {
      this.router.navigate(['/projects']);
    }
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
}
