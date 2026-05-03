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
  sourceLang: string = 'English';
  targetLang: string = 'Arabic';

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
  // Change this signal type
  segmentIdMap = signal<
    { id: string; segNum: number; sourceText: string; kind: string }[]
  >([]);

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
    signal<string>(`You are a professional terminology specialist.

## Task

Extract key terms from the provided {{SOURCE_LANG}} text and translate them into {{TARGET_LANG}}.

## Extract ONLY:

* Company names
* People names
* Abbreviations
* Main key terms

## Rules

* Keep source terms exactly as written
* Provide accurate translations in {{TARGET_LANG}}
* No duplicates
* Ignore irrelevant words
* Use consistent terminology

## Output

Return a table with these EXACT column headers in ENGLISH (do NOT translate the header names):

| # | Source Term | Target Translation | Category |

⚠️ **Column headers must remain in ENGLISH. Only the content (terms and translations) should be in {{SOURCE_LANG}} and {{TARGET_LANG}}.**

* Number rows starting from 1
* Source Term column: terms from {{SOURCE_LANG}} text
* Target Translation column: translations in {{TARGET_LANG}}
* Assign ONE category per term`);

  // Default translation prompt for Step 2
  defaultTranslationPrompt = `
You are a highly experienced professional translator with broad expertise across multiple domains, specializing in {{SOURCE_LANG}} to {{TARGET_LANG}} translation.

## Task
You will receive text segments in numbered cells from a general document. Your task is to provide accurate, professional translations while maintaining the exact meaning, tone, and structure of the source text.

## ⚠️ TERMINOLOGY COMPLIANCE — HIGHEST PRIORITY ⚠️

This is the MOST CRITICAL requirement. You MUST follow the terminology glossary as specified. This is NON-NEGOTIABLE.

**MANDATORY RULES FOR TERMINOLOGY:**
- When a source term from the glossary appears in the source text, you MUST use the corresponding translation from the glossary — no synonyms, no alternatives, no variations.
- This applies to EVERY occurrence of the term in EVERY cell, without exception.
- Do NOT paraphrase, substitute, or use alternative translations for glossary terms.
- If a glossary term appears multiple times in the text, use the SAME glossary translation EVERY time.
- Terminology compliance will be checked by automated QA. Any deviation will be flagged as a critical error.
- The glossary overrides your own translation preferences. Even if you believe a different translation is better, you MUST use the glossary translation.

**CAPITALIZATION FLEXIBILITY FOR GLOSSARY TERMS:**
- Glossary terms may appear in the glossary with specific capitalization (e.g., Title Case). However, you MUST apply standard English capitalization rules when using them in context.
- If a glossary term appears in the MIDDLE of a sentence and it is NOT a proper noun (person name, organization name, country, brand, etc.), use LOWERCASE.
- If a glossary term appears at the BEGINNING of a sentence, capitalize the first letter as normal.
- If a glossary term IS a proper noun (name of a person, organization, institution, country, city, brand, etc.), ALWAYS keep it capitalized regardless of position.
- Example: If the glossary says "Disciplinary Board" but it is not a specific named entity, write "disciplinary board" mid-sentence. But if it refers to a specific named body like "The Dubai Disciplinary Board", keep the capitalization.

## 📋 MANDATORY TERMINOLOGY GLOSSARY
The following terms MUST be translated EXACTLY as specified. No exceptions. No alternatives.

⚠️ **Note: Column headers below are in ENGLISH. Source terms are in {{SOURCE_LANG}}, required translations are in {{TARGET_LANG}}.**

| # | Source Term | Target Translation | Category |
|---|---|---|---|


**REMINDER: Every term above MUST appear in your translation exactly as specified whenever the source term appears in the source text. This is mandatory and will be verified.**

## Other Critical Rules

1. **COMPLETE TRANSLATION — 100% COVERAGE REQUIRED**: 
   - You MUST translate EVERY single cell provided. Do NOT skip, summarize, condense, merge, or omit any cell or any part of its content.
   - Each cell must be translated individually and completely.
   - **SINGLE CHARACTERS**: Even if a cell contains only a single letter or character (e.g., "p", "A", "x"), you MUST translate it if appropriate for the target language. Do NOT skip single-character cells.
   - **SHORT CONTENT**: Cells with 1-3 words are just as important as longer cells. Translate them completely.
   - **EVERY CELL COUNTS**: If you receive 150 cells, you MUST return exactly 150 translated cells in your table. No exceptions.
   - **VERIFICATION**: Your output will be automatically verified to ensure every input cell has a corresponding translation.

2. **NO MODIFICATIONS TO SOURCE CONTENT**: Do NOT add, remove, rephrase, reorder, or alter any information. The translation must be a faithful and complete rendering of the source text. Do not add explanatory notes, comments, or interpretations.

3. **PRESERVE ALL TAGS AND PLACEHOLDERS**: Tags such as {1}, {2}, <1>, </1>, <2>, </2>, {1>text<1}, etc. MUST remain in their EXACT positions in the translation. These are formatting markers — they must NOT be translated, moved, deleted, or modified. They should appear in the target text in the same logical position relative to the surrounding translated text.

4. **MAINTAIN FORMATTING**: Preserve all line breaks, paragraph structures, numbering, bullet points, and any other formatting present in the source text.

5. **PROFESSIONAL REGISTER**: Maintain the formal, professional register appropriate for general documents. Use standard Arabic general terminology and phrasing conventions.

6. **IDIOMATIC AND CREATIVE TRANSLATION — CRITICAL**: This is extremely important. You MUST produce translations that are idiomatic, creative, and natural-sounding in Arabic. Specifically:
   - NEVER produce literal, word-for-word translations. Every sentence must read as if it were originally written by a native Arabic speaker.
   - Use idiomatic expressions, collocations, and phrasing conventions natural to Arabic.
   - Restructure sentences when necessary to achieve natural Arabic flow — you are NOT bound to the source sentence structure.
   - The translation must sound professional, polished, and fluent — not mechanical or robotic.
   - Prioritize readability and eloquence while preserving the complete meaning of the source.
   - For general documents, use the standard phrasing and conventions expected in professional Arabic general writing.

7. **ENGLISH CAPITALIZATION RULES** (when translating into English):
   - Capitalize the first word of every sentence.
   - Capitalize proper nouns: names of people, organizations, institutions, countries, cities, brands, specific laws, and named entities.
   - Do NOT capitalize common nouns, adjectives, or general terms mid-sentence unless they are proper nouns.
   - For titles and headings, use Title Case (capitalize major words).
   - When in doubt whether a term is a proper noun, consider: does it refer to a SPECIFIC named entity? If yes, capitalize. If it is a general/generic reference, use lowercase.
   - Examples: "the court ruled that..." (generic court) vs. "the Supreme Court ruled that..." (specific named court). "the company's policy" (generic) vs. "Google's policy" (named entity).

## Output Format
You MUST present your translation in a table with exactly 3 columns:
| Cell # | Source | Translation |

⚠️ **IMPORTANT: Column headers MUST remain in ENGLISH. Do NOT translate the column names "Cell #", "Source", or "Translation" into {{TARGET_LANG}} or any other language. They must stay exactly as shown above.**

- The Cell # must match the source cell number exactly
- Include the complete source text in the Source column
- Provide the full translation in the Translation column
- Do NOT merge cells or split cells across rows

## Delivery Instructions
- I will send the text in batches of approximately 1500 words per message
- Each batch contains numbered cells
- Translate ALL cells in each batch completely
- Maintain consistency across batches
- If a cell contains only a tag or placeholder with no translatable text, reproduce it as-is in the Translation column

Please confirm you understand these instructions, and I will begin sending the text segments.`;

  // Quick prompt examples
  quickPrompts = [
    'Extract key terms and translate them. Return a table with ENGLISH headers: # | Source Term | Target Translation | Category',
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
    const provider = this.selectedProvider();

    // Claude (Anthropic) doesn't require API key (proxied through Phrase)
    const needsApiKey = provider !== 'anthropic';

    if (!file || !isIdle) return false;
    if (needsApiKey && !apiKey) return false;

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

    // Load project to get source language
    this.phraseApi.getProject(this.projectUid).subscribe({
      next: (project) => {
        this.sourceLang = project.sourceLang || 'English';
        console.log('✅ Source language loaded:', this.sourceLang);

        // Then load job to get target language
        this.phraseApi.getJobs(this.projectUid!).subscribe({
          next: (response) => {
            this.job =
              response.content.find((j) => j.uid === this.jobUid) || null;
            this.loading = false;
            if (this.job) {
              this.targetLang = this.job.targetLang || 'Arabic';
              console.log('✅ Target language loaded:', this.targetLang);
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
      },
      error: (err) => {
        this.error = err.message;
        this.loading = false;
        console.error('Failed to load project:', err);
      },
    });
  }

  /**
   * Update prompts with job-specific information (source and target languages)
   */
  private updatePromptsWithJobInfo(): void {
    if (!this.job) return;

    const sourceLang = this.sourceLang;
    const targetLang = this.targetLang;

    console.log(`🔄 Updating prompts: ${sourceLang} → ${targetLang}`);

    // Update base term extraction prompt
    let updatedBasePrompt = this.baseTermPrompt()
      .replace(/\{\{SOURCE_LANG\}\}/g, sourceLang)
      .replace(/\{\{TARGET_LANG\}\}/g, targetLang);
    this.baseTermPrompt.set(updatedBasePrompt);

    // Update translation prompt
    let updatedTranslationPrompt = this.defaultTranslationPrompt
      .replace(/\{\{SOURCE_LANG\}\}/g, sourceLang)
      .replace(/\{\{TARGET_LANG\}\}/g, targetLang);
    this.customPrompt.set(updatedTranslationPrompt);

    console.log(`✅ Prompts updated for: ${sourceLang} → ${targetLang}`);
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

    console.log('\n📥 DOWNLOADING BILINGUAL FILE from Phrase TMS...');
    console.log('   🔗 Project UID:', this.projectUid);
    console.log('   🔗 Job UID:', this.jobUid);

    this.isDownloadingFile = true;
    this.error = null;

    try {
      const blob = await this.phraseApi.downloadBilingualFile(
        this.projectUid,
        [this.jobUid],
        'MXLF',
      );

      console.log('✅ File downloaded successfully!');
      console.log(
        '   📊 Blob size:',
        (blob.size / 1024).toFixed(2),
        'KB | type:',
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
      const fileName = `${baseName}_bilingual.mxlf`;

      const mimeType = blob.type || 'application/x-xliff+xml';
      this.originalFile = new File([blob], fileName, { type: mimeType });

      // Store the original buffer in the service
      const arrayBuffer = await blob.arrayBuffer();
      this.docxService.setOriginalBuffer(arrayBuffer);

      // Extract segment IDs from the original MXLIFF
      console.log('\n🔍 EXTRACTING SEGMENT STRUCTURE...');
      try {
        const segments = await this.docxService.extractSegmentsFromMxliff();
        this.segmentIdMap.set(segments);
        console.log('✅ Segment structure extracted!');
        console.log(`   📊 Total segments with IDs: ${segments.length}`);
        if (segments.length > 0) {
          console.log('   📄 Sample segments:');
          segments.slice(0, 3).forEach((seg, i) => {
            console.log(
              `      ${i + 1}. Segment #${seg.segNum}: ${seg.sourceText.substring(0, 60)}...`,
            );
          });
        }
      } catch (error: any) {
        console.warn('⚠️ Failed to extract segment IDs:', error.message);
        // Continue anyway - the app can still work without segment IDs
      }

      this.isDownloadingFile = false;
      console.log('\n✅ Bilingual file loaded successfully:', fileName);

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
      // First, check if it's an MXLIFF file
      const fileName = file.name.toLowerCase();
      const isMxliff =
        fileName.endsWith('.mxlf') ||
        fileName.endsWith('.mxliff') ||
        fileName.endsWith('.xliff');

      if (isMxliff) {
        // For MXLIFF files, show source/target pairs
        const arrayBuffer = await file.arrayBuffer();
        const segments =
          await this.docxService.extractMxliffSegmentsForPreview(arrayBuffer);

        if (segments.length === 0) {
          this.errorMessage.set('No segments found in MXLIFF file');
          this.filePreview.set('');
          this.showPreview.set(false);
          return;
        }

        // Create JSON-like preview
        let previewHtml = '<div style="max-height: 400px; overflow-y: auto;">';
        previewHtml +=
          '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
        previewHtml +=
          '<thead><tr style="background: #f3f4f6; position: sticky; top: 0; z-index: 10;">';
        previewHtml +=
          '<th style="padding: 8px; border: 1px solid #e5e7eb; text-align: left; width: 40px;">#</th>';
        previewHtml +=
          '<th style="padding: 8px; border: 1px solid #e5e7eb; text-align: left; width: 45%;">Source</th>';
        previewHtml +=
          '<th style="padding: 8px; border: 1px solid #e5e7eb; text-align: left; width: 45%;">Target</th>';
        previewHtml += '</tr></thead><tbody>';

        segments.slice(0, 50).forEach((segment, i) => {
          previewHtml += '<tr>';
          previewHtml += `<td style="padding: 8px; border: 1px solid #e5e7eb; font-weight: 600; color: #6b7280;">${i + 1}</td>`;
          previewHtml += `<td style="padding: 8px; border: 1px solid #e5e7eb;">${this.escapeHtml(segment.source)}</td>`;

          if (segment.target) {
            previewHtml += `<td style="padding: 8px; border: 1px solid #e5e7eb; background: #f0fdf4;">${this.escapeHtml(segment.target)}</td>`;
          } else {
            previewHtml += `<td style="padding: 8px; border: 1px solid #e5e7eb; color: #9ca3af; font-style: italic;">Empty</td>`;
          }
          previewHtml += '</tr>';
        });

        if (segments.length > 50) {
          previewHtml +=
            '<tr><td colspan="3" style="padding: 8px; text-align: center; color: #6b7280; font-style: italic;">';
          previewHtml += `... and ${segments.length - 50} more segments</td></tr>`;
        }

        previewHtml += '</tbody></table></div>';

        // Calculate total characters
        const totalChars = segments.reduce(
          (sum, seg) => sum + seg.source.length + seg.target.length,
          0,
        );
        previewHtml += `<div style="margin-top: 12px; font-size: 13px; color: #6b7280;">Total: ${segments.length} segments | ${totalChars} characters</div>`;

        this.filePreview.set(previewHtml);
        this.showPreview.set(true);
        console.log('✅ MXLIFF preview ready:', segments.length, 'segments');
      } else {
        // For other files (DOCX), use simple text extraction
        const extractedText = await this.docxService.extractTextFromFile(file);

        // Create a formatted table preview
        const segments = extractedText.split('\n\n').filter((s) => s.trim());
        let previewHtml = '<div style="max-height: 300px; overflow-y: auto;">';
        previewHtml +=
          '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
        previewHtml +=
          '<thead><tr style="background: #f3f4f6; position: sticky; top: 0;">';
        previewHtml +=
          '<th style="padding: 8px; border: 1px solid #e5e7eb; text-align: left; width: 50px;">#</th>';
        previewHtml +=
          '<th style="padding: 8px; border: 1px solid #e5e7eb; text-align: left;">Source Text</th>';
        previewHtml += '</tr></thead><tbody>';

        segments.slice(0, 50).forEach((segment, i) => {
          previewHtml += '<tr>';
          previewHtml += `<td style="padding: 8px; border: 1px solid #e5e7eb; font-weight: 600; color: #6b7280;">${i + 1}</td>`;
          previewHtml += `<td style="padding: 8px; border: 1px solid #e5e7eb;">${this.escapeHtml(segment)}</td>`;
          previewHtml += '</tr>';
        });

        if (segments.length > 50) {
          previewHtml +=
            '<tr><td colspan="2" style="padding: 8px; text-align: center; color: #6b7280; font-style: italic;">';
          previewHtml += `... and ${segments.length - 50} more segments</td></tr>`;
        }

        previewHtml += '</tbody></table></div>';
        previewHtml += `<div style="margin-top: 12px; font-size: 13px; color: #6b7280;">Total: ${segments.length} segments | ${extractedText.length} characters</div>`;

        this.filePreview.set(previewHtml);
        this.showPreview.set(true);
        console.log(
          '✅ File preview ready:',
          extractedText.length,
          'chars,',
          segments.length,
          'segments',
        );
      }
    } catch (error: any) {
      console.error('❌ Preview extraction failed:', error);
      this.errorMessage.set(`Failed to extract file content: ${error.message}`);
      this.filePreview.set('');
      this.showPreview.set(false);
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

  /**
   * Build translations array from translation table
   * Maps table rows to segment IDs using segmentIdMap
   */
  private async buildTranslationsFromTable(tableData: {
    headers: string[];
    rows: string[][];
  }): Promise<{ segmentId: string; targetText: string }[]> {
    const allSegments = this.segmentIdMap();
    const translations: { segmentId: string; targetText: string }[] = [];

    // Only translate-kind segments were sent to AI, so cell #1 = first translate segment
    const translatableSegments = allSegments.filter(
      (s) => s.kind === 'translate',
    );

    const cellNumIndex = tableData.headers.findIndex(
      (h) => h.toLowerCase().includes('cell') || h.toLowerCase().includes('#'),
    );

    // Check for "Translation" in multiple languages as fallback
    // Common translations: Translation (en), Traduction (fr), Traducción (es),
    // Tradução (pt), Traduzione (it), Übersetzung (de), Vertaling (nl), ترجمة (ar), 翻译 (zh)
    const translationIndex = tableData.headers.findIndex((h) => {
      const lower = h.toLowerCase();
      return (
        lower.includes('translation') ||
        lower.includes('traduction') ||
        lower.includes('traducción') ||
        lower.includes('traduccion') ||
        lower.includes('tradução') ||
        lower.includes('traducao') ||
        lower.includes('traduzione') ||
        lower.includes('übersetzung') ||
        lower.includes('ubersetzung') ||
        lower.includes('vertaling') ||
        h.includes('ترجمة') ||
        h.includes('翻译') ||
        h.includes('翻譯') ||
        // If AI used 3rd column and we can't match, assume it's the translation column
        tableData.headers.indexOf(h) === 2
      );
    });

    if (cellNumIndex === -1 || translationIndex === -1) {
      console.warn('⚠️ Could not find Cell # or Translation columns');
      console.warn('⚠️ Headers found:', tableData.headers);
      return translations;
    }

    console.log('✅ Table headers detected:');
    console.log(`   Column 0: "${tableData.headers[cellNumIndex]}" (Cell #)`);
    console.log(`   Column 1: "${tableData.headers[1]}" (Source)`);
    console.log(
      `   Column 2: "${tableData.headers[translationIndex]}" (Translation)`,
    );
    if (tableData.headers[translationIndex] !== 'Translation') {
      console.warn(
        `   ⚠️ WARNING: Translation column header is "${tableData.headers[translationIndex]}" instead of "Translation"`,
      );
      console.warn(
        `   ⚠️ The AI translated the column name. This should remain as "Translation" in English.`,
      );
    }

    tableData.rows.forEach((row, rowIndex) => {
      const cellNumStr = row[cellNumIndex];
      const translation = row[translationIndex];

      if (!cellNumStr || !translation) return;

      const cellNum = parseInt(cellNumStr, 10);
      if (isNaN(cellNum)) {
        console.warn(`⚠️ Invalid cell number: "${cellNumStr}"`);
        return;
      }

      // Cell #1 = index 0 in translatableSegments only
      const segment = translatableSegments[cellNum - 1];
      if (!segment) {
        console.warn(`⚠️ No translatable segment for cell #${cellNum}`);
        return;
      }

      if (rowIndex < 3) {
        console.log(
          `   ✓ Cell #${cellNum} → [${segment.id.substring(0, 20)}...] "${translation.substring(0, 60)}..."`,
        );
      }

      translations.push({
        segmentId: segment.id,
        targetText: translation.trim(),
      });
    });

    // ✅ VALIDATION: Ensure 100% coverage
    console.log(
      '\n🔍 ============ TRANSLATION COVERAGE VALIDATION ============',
    );
    console.log(`   📊 Expected translations: ${translatableSegments.length}`);
    console.log(`   📊 Received translations: ${translations.length}`);

    const coveragePercent = (
      (translations.length / translatableSegments.length) *
      100
    ).toFixed(1);
    console.log(`   📊 Coverage: ${coveragePercent}%`);

    if (translations.length < translatableSegments.length) {
      const missing = translatableSegments.length - translations.length;
      console.warn(
        `   ⚠️  WARNING: ${missing} segments are MISSING translations!`,
      );
      console.warn(`   ⚠️  Some content will NOT be translated!`);

      // Find which cells are missing
      const receivedCells = new Set(translations.map((t) => t.segmentId));
      const missingSegments = translatableSegments.filter(
        (s) => !receivedCells.has(s.id),
      );

      console.warn(`   ⚠️  Missing segments (first 5):`);
      missingSegments.slice(0, 5).forEach((s) => {
        console.warn(
          `      Cell #${s.segNum + 1}: "${s.sourceText.substring(0, 50)}..."`,
        );
      });

      throw new Error(
        `AI did not translate all segments. Expected ${translatableSegments.length} translations but received ${translations.length}. ` +
          `${missing} segments are missing. Please check the AI response and try again.`,
      );
    } else if (translations.length > translatableSegments.length) {
      console.warn(
        `   ⚠️  WARNING: AI returned MORE translations than expected!`,
      );
      console.warn(`   ⚠️  Extra translations will be ignored.`);
    } else {
      console.log(
        `   ✅ PERFECT: All ${translatableSegments.length} segments have translations!`,
      );
    }
    console.log(`═════════════════════════════════════════════════════════\n`);

    console.log(
      `✅ Built ${translations.length} translations from ${tableData.rows.length} table rows`,
    );
    return translations;
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

    console.log('\n🎯 ============ STARTING TRANSLATION ============');
    console.log('📍 Workflow Step:', step);
    console.log('🤖 Provider:', provider.toUpperCase());
    console.log('📂 File:', file.name);
    console.log('================================================\n');

    this.errorMessage.set(null);
    this.translatedBlob.set(null);
    this.progressStep.set('reading');

    try {
      setTimeout(() => this.progressStep.set('translating'), 500);

      let prompt = '';
      if (step === 1) {
        prompt = this.baseTermPrompt();
        console.log('📝 Using TermBase extraction prompt');
        console.log('   Length:', prompt.length, 'chars');
      } else if (step === 2) {
        prompt = this.finalPrompt();
        console.log('📝 Using translation prompt with glossary');
        console.log('   Length:', prompt.length, 'chars');
        const glossaryLines = this.baseTermTable()?.rows.length || 0;
        console.log('   📚 Glossary terms:', glossaryLines);
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
      console.log('\n📊 PARSING AI RESPONSE...');
      const tableData = this.parseMarkdownTable(result.responseText);

      if (tableData) {
        console.log('✅ Table structure detected!');
        console.log('   📋 Headers:', tableData.headers.join(', '));
        console.log('   📊 Rows:', tableData.rows.length);

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

          // Build translations array by mapping table rows to segment IDs
          const translations = await this.buildTranslationsFromTable(tableData);

          // Inject translations into original file (MXLIFF or DOCX)
          const fileName = file.name.toLowerCase();
          const isMxliff =
            fileName.endsWith('.mxlf') ||
            fileName.endsWith('.mxliff') ||
            fileName.endsWith('.xliff');

          const modifiedBlob = isMxliff
            ? await this.docxService.injectTranslationsIntoMxliff(translations)
            : await this.docxService.injectTranslationsAndBuild(translations);

          setTimeout(() => {
            this.translatedBlob.set(modifiedBlob);
            // Use the job's original filename
            const jobFilename = this.job?.filename || result.filename;
            this.translatedFilename.set(jobFilename);
            this.progressStep.set('complete');
            this.nextStep();
          }, 500);
        }
      } else if (step === 2) {
        // If no table data, we can't inject translations properly
        console.warn(
          '⚠️ No translation table found, cannot inject translations',
        );
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
    let filename = this.translatedFilename();

    if (!filename) return;

    console.log('\n💾 PREPARING DOWNLOAD...');
    console.log('   📂 Filename:', filename);
    console.log('   🔧 Format: MXLIFF');

    try {
      let blob: Blob;

      if (table && table.headers.length > 0 && table.rows.length > 0) {
        console.log('   ✏️ Table was edited, re-injecting translations...');
        console.log('   📊 Table rows to inject:', table.rows.length);
        // Build translations array from edited table
        const translations = await this.buildTranslationsFromTable(table);
        console.log('   📊 Translations built:', translations.length);

        // Always inject as MXLIFF for download
        blob =
          await this.docxService.injectTranslationsIntoMxliff(translations);
      } else {
        const originalBlob = this.translatedBlob();
        if (!originalBlob) return;
        blob = originalBlob;
      }

      // Ensure filename ends with .mxliff
      if (!filename.toLowerCase().endsWith('.mxliff')) {
        filename = filename.replace(/\.(docx|mxlf|xliff)$/i, '') + '.mxliff';
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

    console.log('\n📤 ============ UPLOADING TO PHRASE TMS ============');
    console.log('   📂 File:', filename);
    console.log('   🔗 Job UID:', this.jobUid);

    this.isUploading.set(true);
    this.uploadSuccess.set(false);
    this.uploadMessage.set(null);
    this.errorMessage.set(null);

    try {
      let blob: Blob;

      // Build the file (same logic as download)
      if (table && table.headers.length > 0 && table.rows.length > 0) {
        console.log('   ✏️ Using edited table data...');
        console.log('   📊 Table rows:', table.rows.length);
        console.log('   📊 Segment map entries:', this.segmentIdMap().length);

        // Build translations array from edited table
        const translations = await this.buildTranslationsFromTable(table);

        if (translations.length === 0) {
          throw new Error(
            'No translations could be mapped from the table. Check that Cell # column matches segments.',
          );
        }

        console.log(`   ✅ Mapped ${translations.length} translations`);
        console.log('   📄 First 3 translations:');
        translations.slice(0, 3).forEach((t, i) => {
          console.log(
            `      ${i + 1}. [${t.segmentId}] → "${t.targetText.substring(0, 60)}..."`,
          );
        });

        // Check file type and use appropriate injection method
        const fileName = this.originalFile?.name.toLowerCase() || '';
        const isMxliff =
          fileName.endsWith('.mxlf') ||
          fileName.endsWith('.mxliff') ||
          fileName.endsWith('.xliff');

        console.log(`   🔧 File type: ${isMxliff ? 'MXLIFF' : 'DOCX'}`);

        // Inject into original file structure
        blob = isMxliff
          ? await this.docxService.injectTranslationsIntoMxliff(translations)
          : await this.docxService.injectTranslationsAndBuild(translations);

        console.log(
          `   ✅ Injection complete! Blob size: ${(blob.size / 1024).toFixed(2)} KB`,
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
      const fileName = this.originalFile?.name.toLowerCase() || '';
      const isMxliff =
        fileName.endsWith('.mxlf') ||
        fileName.endsWith('.mxliff') ||
        fileName.endsWith('.xliff');

      const mimeType = isMxliff
        ? 'application/x-xliff+xml'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      // Use original filename for upload (preserve .mxliff extension)
      const uploadFilename = this.originalFile?.name || filename;
      console.log(`   📎 Upload filename: ${uploadFilename}`);
      console.log(`   📎 MIME type: ${mimeType}`);

      const file = new File([blob], uploadFilename, {
        type: mimeType,
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
