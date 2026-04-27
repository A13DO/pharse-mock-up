import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PhraseApiService } from '../../../core/services/phrase-api.service';

@Component({
  selector: 'app-job-file-download',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './job-file-download.component.html',
  styleUrl: './job-file-download.component.scss',
})
export class JobFileDownloadComponent {
  @Input({ required: true }) projectUid!: string;
  @Input({ required: true }) jobUid!: string;
  @Input() buttonText = 'Download';
  @Input() buttonClass = '';

  private phraseApiService = inject(PhraseApiService);

  isDownloading = false;
  error: string | null = null;

  downloadFile(): void {
    if (this.isDownloading) return;

    this.isDownloading = true;
    this.error = null;

    this.phraseApiService
      .downloadOriginalFile(this.projectUid, this.jobUid)
      .subscribe({
        next: () => {
          this.isDownloading = false;
        },
        error: (err) => {
          this.isDownloading = false;
          this.error = err.message || 'Failed to download file';
          console.error('Download error:', err);
        },
      });
  }
}
