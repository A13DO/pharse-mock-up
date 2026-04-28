import { Component, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DocxTranslationService,
  Provider,
} from '../services/docx-translation.service';

interface ProviderInfo {
  id: Provider;
  name: string;
  color: string;
  keyLabel: string;
  keyPlaceholder: string;
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
      color: '#c96442',
      keyLabel: 'Anthropic API Key',
      keyPlaceholder: 'sk-ant-...',
    },
    {
      id: 'openai',
      name: 'OpenAI GPT-4',
      color: '#10a37f',
      keyLabel: 'OpenAI API Key',
      keyPlaceholder: 'sk-proj-...',
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      color: '#4285f4',
      keyLabel: 'Gemini API Key',
      keyPlaceholder: 'AIza...',
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
    // Load saved API keys on init
    this.loadApiKeys();
  }

  /**
   * Select a provider and load its saved API key
   */
  selectProvider(provider: Provider): void {
    this.selectedProvider.set(provider);
    this.loadApiKey(provider);
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
      // Simulate step transitions
      setTimeout(() => this.progressStep.set('translating'), 500);

      const result = await this.docxService.translateDocument(
        file,
        prompt,
        provider,
        apiKey,
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
