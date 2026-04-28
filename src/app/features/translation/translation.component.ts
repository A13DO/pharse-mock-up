import { Component, inject, OnInit } from '@angular/core';
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
  color: string;
  keyLabel: string;
  keyPlaceholder: string;
  keyUrl: string;
  freeTier?: boolean;
  models: ModelOption[];
}

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

  projectUid: string | null = null;
  jobUid: string | null = null;
  job: Job | null = null;

  loading = false;
  error: string | null = null;
  successMessage: string | null = null;

  // File and AI Translation state
  originalFile: File | null = null;
  translatedFile: Blob | null = null;
  translatedFileName: string = '';

  isTranslating = false;
  isDownloadingFile = false;
  translationProgress = 0;

  translationPrompt: string = '';
  customInstructions: string = '';

  // Provider & model selection (persisted per localStorage)
  selectedProvider: Provider = 'anthropic';
  selectedModel: string = 'claude-opus-4-20250514';
  apiKey: string = '';
  showApiKey: boolean = false;

  providers: ProviderInfo[] = [
    {
      id: 'anthropic',
      name: 'Anthropic Claude',
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

  get selectedProviderInfo(): ProviderInfo | undefined {
    return this.providers.find((p) => p.id === this.selectedProvider);
  }

  ngOnInit(): void {
    this.projectUid = this.route.snapshot.paramMap.get('projectUid');
    this.jobUid = this.route.snapshot.paramMap.get('jobUid');

    if (!this.projectUid || !this.jobUid) {
      this.error = 'Missing project or job identifier';
      return;
    }

    this.loadSavedSettings();
    this.loadJobDetails();
    this.initializePrompt();
  }

  private loadSavedSettings(): void {
    const savedProvider = localStorage.getItem(
      'docx_ai_provider',
    ) as Provider | null;
    if (savedProvider && this.providers.some((p) => p.id === savedProvider)) {
      this.selectedProvider = savedProvider;
    }
    const info = this.selectedProviderInfo;
    const savedModel = localStorage.getItem(
      `docx_ai_model_${this.selectedProvider}`,
    );
    this.selectedModel = savedModel || info?.models[0]?.id || '';
    this.apiKey =
      localStorage.getItem(`docx_ai_key_${this.selectedProvider}`) || '';
  }

  initializePrompt(): void {
    this.translationPrompt =
      'Translate this document from English to the target language. ' +
      'Maintain the original formatting, structure, and style. ' +
      'Ensure accuracy and cultural appropriateness.';
  }

  loadJobDetails(): void {
    if (!this.projectUid || !this.jobUid) return;

    this.loading = true;
    this.phraseApi.getJobs(this.projectUid).subscribe({
      next: (response) => {
        this.job = response.content.find((j) => j.uid === this.jobUid) || null;
        this.loading = false;
        if (this.job) {
          this.updatePromptWithLanguage();
          // Auto-fetch the job file — no manual step needed
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

  updatePromptWithLanguage(): void {
    if (this.job?.targetLang) {
      this.translationPrompt =
        `Translate this document to ${this.job.targetLang.toUpperCase()}. ` +
        'Maintain the original formatting, structure, and style. ' +
        'Ensure accuracy and cultural appropriateness.';
    }
  }

  selectProvider(provider: Provider): void {
    this.selectedProvider = provider;
    localStorage.setItem('docx_ai_provider', provider);
    const info = this.providers.find((p) => p.id === provider);
    const savedModel = localStorage.getItem(`docx_ai_model_${provider}`);
    this.selectedModel = savedModel || info?.models[0]?.id || '';
    this.apiKey = localStorage.getItem(`docx_ai_key_${provider}`) || '';
  }

  selectModel(modelId: string): void {
    this.selectedModel = modelId;
    localStorage.setItem(`docx_ai_model_${this.selectedProvider}`, modelId);
  }

  saveApiKey(): void {
    if (this.apiKey.trim()) {
      localStorage.setItem(
        `docx_ai_key_${this.selectedProvider}`,
        this.apiKey.trim(),
      );
    }
  }

  toggleApiKeyVisibility(): void {
    this.showApiKey = !this.showApiKey;
  }

  async downloadOriginalFile(): Promise<void> {
    if (
      !this.projectUid ||
      !this.jobUid ||
      this.isDownloadingFile ||
      this.originalFile
    )
      return;

    this.isDownloadingFile = true;
    this.error = null;

    try {
      const blob = await this.phraseApi.downloadOriginalFileAsBlob(
        this.projectUid,
        this.jobUid,
      );

      console.log('📦 Blob size:', blob.size, 'bytes | type:', blob.type);

      // If small, it's likely a JSON/HTML error response — surface it
      if (blob.size < 10_000) {
        const preview = await blob.text();
        console.warn('⚠️ Small blob content (likely not a DOCX):', preview);
      }

      const fileName = this.job?.filename || 'document.docx';
      // Force the correct MIME type — Phrase may return an empty type
      const mimeType =
        blob.type ||
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      this.originalFile = new File([blob], fileName, { type: mimeType });
      this.isDownloadingFile = false;
    } catch (err: any) {
      this.error = err.message || 'Failed to fetch the job file';
      this.isDownloadingFile = false;
      console.error('Download error:', err);
    }
  }

  async translateWithAI(): Promise<void> {
    if (!this.originalFile || this.isTranslating) return;
    if (!this.apiKey.trim()) {
      this.error = 'Please enter your API key before translating.';
      return;
    }

    this.isTranslating = true;
    this.translationProgress = 0;
    this.error = null;
    this.successMessage = null;

    const progressInterval = setInterval(() => {
      if (this.translationProgress < 90) this.translationProgress += 10;
    }, 500);

    try {
      const fullPrompt = this.customInstructions
        ? `${this.translationPrompt}\n\nAdditional instructions: ${this.customInstructions}`
        : this.translationPrompt;

      const result = await this.docxService.translateDocument(
        this.originalFile,
        fullPrompt,
        this.selectedProvider,
        this.apiKey,
        this.selectedModel,
      );

      clearInterval(progressInterval);
      this.translationProgress = 100;
      this.translatedFile = result.blob;
      this.translatedFileName = result.filename;
      this.successMessage = 'Document translated successfully!';
    } catch (err: any) {
      clearInterval(progressInterval);
      this.error = err.message || 'Translation failed';
      this.translationProgress = 0;
    } finally {
      this.isTranslating = false;
    }
  }

  downloadTranslatedFile(): void {
    if (!this.translatedFile) return;

    const url = window.URL.createObjectURL(this.translatedFile);
    const link = document.createElement('a');
    link.href = url;
    link.download = this.translatedFileName || 'translated-document.docx';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }

  uploadTranslatedToPhrase(): void {
    alert('Upload to Phrase TMS will be implemented');
  }

  goBack(): void {
    if (this.projectUid) {
      this.router.navigate(['/projects', this.projectUid]);
    } else {
      this.router.navigate(['/projects']);
    }
  }

  resetTranslation(): void {
    this.originalFile = null;
    this.translatedFile = null;
    this.translatedFileName = '';
    this.translationProgress = 0;
    this.error = null;
    this.successMessage = null;
    // Re-fetch the job file after reset
    this.downloadOriginalFile();
  }
}
