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

  // Quick prompt examples
  quickPrompts = [
    'Translate this document to Spanish while maintaining professional tone and technical accuracy.',
    'Translate to French. Keep all proper nouns and brand names unchanged.',
    'Translate to German. Preserve all formatting, bullet points, and numbered lists exactly.',
    'Translate to Japanese. Use formal language appropriate for business documentation.',
  ];

  // Signals for reactive state
  selectedProvider = signal<Provider>('anthropic');
  selectedModel = signal<string>('claude-opus-4-20250514');
  apiKey = signal<string>('');
  showApiKey = signal<boolean>(false);
  uploadedFile = signal<File | null>(null);
  customPrompt = signal<string>('');
  progressStep = signal<ProgressStep>('idle');
  errorMessage = signal<string | null>(null);
  translatedBlob = signal<Blob | null>(null);
  translatedFilename = signal<string>('');
  isDragging = signal<boolean>(false);

  // Computed values
  selectedProviderInfo = computed(() =>
    this.providers.find((p) => p.id === this.selectedProvider()),
  );

  canTranslate = computed(
    () =>
      this.uploadedFile() !== null &&
      this.customPrompt().trim() !== '' &&
      this.apiKey().trim() !== '' &&
      this.progressStep() === 'idle',
  );

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
  private handleFile(file: File): void {
    if (!file.name.endsWith('.docx')) {
      this.errorMessage.set('Please upload a .docx file');
      return;
    }

    this.uploadedFile.set(file);
    this.errorMessage.set(null);
    console.log('📎 File uploaded:', file.name);
  }

  /**
   * Use a quick prompt example
   */
  useQuickPrompt(prompt: string): void {
    this.customPrompt.set(prompt);
  }

  /**
   * Start the translation process
   */
  async translate(): Promise<void> {
    if (!this.canTranslate()) return;

    const file = this.uploadedFile();
    const prompt = this.customPrompt();
    const provider = this.selectedProvider();
    const apiKey = this.apiKey();

    if (!file) return;

    this.errorMessage.set(null);
    this.translatedBlob.set(null);
    this.progressStep.set('reading');

    try {
      setTimeout(() => this.progressStep.set('translating'), 500);

      const result = await this.docxService.translateDocument(
        file,
        prompt,
        provider,
        apiKey,
        this.selectedModel(),
      );

      this.progressStep.set('building');

      // Brief pause before completion
      setTimeout(() => {
        this.translatedBlob.set(result.blob);
        this.translatedFilename.set(result.filename);
        this.progressStep.set('complete');
      }, 500);
    } catch (error: any) {
      console.error('❌ Translation failed:', error);
      this.errorMessage.set(error.message || 'Translation failed');
      this.progressStep.set('idle');
    }
  }

  /**
   * Download the translated document
   */
  downloadTranslation(): void {
    const blob = this.translatedBlob();
    const filename = this.translatedFilename();

    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
