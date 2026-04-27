import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HeaderComponent } from '../../layout/header/header.component';
import { PhraseApiService, Job } from '../../core/services/phrase-api.service';
import { TranslationService } from '../../core/services/translation.service';

interface AIModel {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'google';
  description: string;
  supportsFileUpload: boolean;
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
  private translationService = inject(TranslationService);

  projectUid: string | null = null;
  jobUid: string | null = null;
  job: Job | null = null;

  loading = false;
  error: string | null = null;
  successMessage: string | null = null;

  // File and AI Translation settings
  originalFile: File | null = null;
  translatedFile: Blob | null = null;
  translatedFileName: string = '';

  selectedModel: AIModel | null = null;
  isTranslating = false;
  isDownloadingFile = false;
  translationProgress = 0;

  translationPrompt: string = '';
  customInstructions: string = '';

  availableModels: AIModel[] = [
    {
      id: 'gpt-4',
      name: 'GPT-4',
      provider: 'openai',
      description: 'Most capable model for document translation',
      supportsFileUpload: true,
    },
    {
      id: 'gpt-3.5-turbo',
      name: 'GPT-3.5 Turbo',
      provider: 'openai',
      description: 'Fast and efficient for standard translations',
      supportsFileUpload: false,
    },
    {
      id: 'claude-3-opus',
      name: 'Claude 3 Opus',
      provider: 'anthropic',
      description: 'Advanced reasoning for document translation',
      supportsFileUpload: true,
    },
    {
      id: 'claude-3-sonnet',
      name: 'Claude 3 Sonnet',
      provider: 'anthropic',
      description: 'Balanced performance and quality',
      supportsFileUpload: true,
    },
    {
      id: 'gemini-pro',
      name: 'Gemini Pro',
      provider: 'google',
      description: "Google's advanced AI model",
      supportsFileUpload: true,
    },
  ];

  ngOnInit(): void {
    this.projectUid = this.route.snapshot.paramMap.get('projectUid');
    this.jobUid = this.route.snapshot.paramMap.get('jobUid');

    if (!this.projectUid || !this.jobUid) {
      this.error = 'Missing project or job identifier';
      return;
    }

    this.selectedModel = this.availableModels[0];
    this.loadJobDetails();
    this.initializePrompt();
  }

  initializePrompt(): void {
    this.translationPrompt = `Translate this document from English to the target language. Maintain the original formatting, structure, and style. Ensure accuracy and cultural appropriateness.`;
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
      this.translationPrompt = `Translate this document to ${this.job.targetLang.toUpperCase()}. Maintain the original formatting, structure, and style. Ensure accuracy and cultural appropriateness.`;
    }
  }

  async downloadOriginalFile(): Promise<void> {
    if (!this.projectUid || !this.jobUid || this.isDownloadingFile) return;

    this.isDownloadingFile = true;
    this.error = null;

    try {
      const blob = await this.phraseApi.downloadOriginalFileAsBlob(
        this.projectUid,
        this.jobUid,
      );

      const fileName = this.job?.filename || 'document.docx';
      this.originalFile = new File([blob], fileName, {
        type: blob.type,
      });

      this.successMessage = 'File downloaded successfully. Ready to translate.';
      this.isDownloadingFile = false;
    } catch (err: any) {
      this.error = err.message || 'Failed to download file';
      this.isDownloadingFile = false;
      console.error('Download error:', err);
    }
  }

  async translateWithAI(): Promise<void> {
    if (!this.selectedModel || !this.originalFile || this.isTranslating) return;

    this.isTranslating = true;
    this.translationProgress = 0;
    this.error = null;
    this.successMessage = null;

    try {
      const fullPrompt = this.customInstructions
        ? `${this.translationPrompt}\n\nAdditional instructions: ${this.customInstructions}`
        : this.translationPrompt;

      // Simulate progress
      const progressInterval = setInterval(() => {
        if (this.translationProgress < 90) {
          this.translationProgress += 10;
        }
      }, 500);

      const result = await this.translationService.translateDocument(
        this.originalFile,
        this.selectedModel.id,
        fullPrompt,
      );

      clearInterval(progressInterval);
      this.translationProgress = 100;

      this.translatedFile = result.file;
      this.translatedFileName = result.filename;
      this.successMessage = 'Document translated successfully!';
      this.isTranslating = false;
    } catch (err: any) {
      this.error = err.message || 'Failed to translate document';
      this.isTranslating = false;
      this.translationProgress = 0;
      console.error('Translation error:', err);
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
    // Future implementation: Upload translated file back to Phrase TMS
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
  }
}
