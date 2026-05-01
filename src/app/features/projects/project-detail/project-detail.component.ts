import { Component, inject, OnInit } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import {
  PhraseApiService,
  ProjectDetail,
  Job,
  JobStatus,
} from '../../../core/services/phrase-api.service';
import { HeaderComponent } from '../../../layout/header/header.component';

@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, HeaderComponent],
  templateUrl: './project-detail.component.html',
  styleUrl: './project-detail.component.scss',
})
export class ProjectDetailComponent implements OnInit {
  private phraseApi = inject(PhraseApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  project: ProjectDetail | null = null;
  jobs: Job[] = [];
  loading = false;
  loadingJobs = false;
  error: string | null = null;

  // Status dropdown state
  statusDropdownOpen: { [jobUid: string]: boolean } = {};
  updatingStatus: { [jobUid: string]: boolean } = {};
  currentOpenJobUid: string | null = null;
  dropdownPosition = { top: 0, left: 0 };

  // Available job statuses
  readonly jobStatuses: JobStatus[] = [
    'NEW',
    'ACCEPTED',
    'DECLINED',
    'REJECTED',
    'DELIVERED',
    'EMAILED',
    'COMPLETED',
    'CANCELLED',
  ];

  ngOnInit(): void {
    this.loadProjectDetail();
  }

  loadProjectDetail(): void {
    const projectUid = this.route.snapshot.paramMap.get('uid');
    if (!projectUid) {
      this.error = 'Project UID not provided';
      return;
    }

    this.loading = true;
    this.error = null;

    this.phraseApi.getProject(projectUid).subscribe({
      next: (project) => {
        this.project = project;
        this.loading = false;
        this.loadJobs(projectUid);
      },
      error: (err) => {
        this.error = err.message;
        this.loading = false;
        console.error('Failed to load project:', err);
      },
    });
  }

  loadJobs(projectUid: string): void {
    this.loadingJobs = true;
    this.phraseApi.getJobs(projectUid).subscribe({
      next: (response) => {
        this.jobs = response.content;
        this.loadingJobs = false;
      },
      error: (err) => {
        console.error('Failed to load jobs:', err);
        this.loadingJobs = false;
      },
    });
  }

  onAddJob(): void {
    if (this.project?.uid) {
      this.router.navigate(['/projects', this.project.uid, 'jobs', 'create'], {
        queryParams: { projectUid: this.project.uid },
      });
    }
  }

  getStatusSeverity(status: string): 'success' | 'warning' | 'danger' | 'info' {
    switch (status) {
      case 'NEW':
        return 'info';
      case 'ACCEPTED':
      case 'EMAILED':
        return 'warning';
      case 'COMPLETED':
        return 'success';
      case 'DECLINED':
      case 'CANCELLED':
        return 'danger';
      default:
        return 'info';
    }
  }

  getJobStatusBadgeClass(status: string): string {
    switch (status) {
      case 'NEW':
        return 'bg-blue-100 text-blue-800';
      case 'ACCEPTED':
        return 'bg-green-100 text-green-800';
      case 'EMAILED':
        return 'bg-purple-100 text-purple-800';
      case 'COMPLETED':
        return 'bg-emerald-100 text-emerald-800';
      case 'DECLINED':
      case 'REJECTED':
        return 'bg-red-100 text-red-800';
      case 'DELIVERED':
        return 'bg-teal-100 text-teal-800';
      case 'CANCELLED':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  }

  formatDate(date: string): string {
    return new Date(date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Download bilingual file for a specific job
   * @param job - Job to download
   * @param format - File format (MXLF, DOCX, XLIFF, TMX)
   */
  async downloadBilingualFile(
    job: Job,
    format: 'MXLF' | 'DOCX' | 'XLIFF' | 'TMX' = 'MXLF',
  ): Promise<void> {
    if (!this.project?.uid) {
      console.error('Project UID not available');
      return;
    }

    try {
      const blob = await this.phraseApi.downloadBilingualFile(
        this.project.uid,
        [job.uid],
        format,
      );

      // Determine file extension based on format
      const extensions: Record<string, string> = {
        MXLF: 'mxliff',
        DOCX: 'docx',
        XLIFF: 'xliff',
        TMX: 'tmx',
      };
      const ext = extensions[format] || 'mxliff';

      // Create download filename
      const filename = `${job.filename.replace(/\.[^/.]+$/, '')}_bilingual.${ext}`;

      // Trigger download
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();

      // Cleanup
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);

      console.log('✅ Bilingual file downloaded successfully');
    } catch (error) {
      console.error('❌ Failed to download bilingual file:', error);
      this.error = 'Failed to download bilingual file';
    }
  }

  toggleStatusDropdown(jobUid: string, buttonElement: HTMLElement): void {
    // Close all other dropdowns
    Object.keys(this.statusDropdownOpen).forEach((uid) => {
      if (uid !== jobUid) {
        this.statusDropdownOpen[uid] = false;
      }
    });

    // Toggle current dropdown
    const isOpening = !this.statusDropdownOpen[jobUid];
    this.statusDropdownOpen[jobUid] = isOpening;

    if (isOpening) {
      this.currentOpenJobUid = jobUid;
      // Calculate position based on button
      const rect = buttonElement.getBoundingClientRect();
      const dropdownWidth = 192; // w-48 = 12rem = 192px
      const dropdownHeight = 360; // max-h-96 estimate

      // Position to the left of the button (since it's in the Status column)
      let left = rect.right - dropdownWidth;
      let top = rect.bottom + 4;

      // Check if dropdown would go off the right edge
      if (left < 8) {
        left = 8;
      }

      // Check if dropdown would go off the bottom edge
      if (top + dropdownHeight > window.innerHeight) {
        top = rect.top - dropdownHeight - 4;
      }

      // Check if dropdown would go off the top edge
      if (top < 8) {
        top = 8;
      }

      this.dropdownPosition = { top, left };
    } else {
      this.currentOpenJobUid = null;
    }
  }

  closeStatusDropdown(jobUid: string): void {
    this.statusDropdownOpen[jobUid] = false;
    this.currentOpenJobUid = null;
  }

  getJobByUid(jobUid: string): Job | undefined {
    return this.jobs.find((job) => job.uid === jobUid);
  }

  async updateJobStatus(job: Job, newStatus: JobStatus): Promise<void> {
    if (!this.project?.uid) {
      console.error('Project UID not available');
      return;
    }

    this.updatingStatus[job.uid] = true;
    this.error = null;

    this.phraseApi
      .updateJobStatus(this.project.uid, [job.uid], newStatus)
      .subscribe({
        next: () => {
          // Update local job status
          job.status = newStatus;
          this.updatingStatus[job.uid] = false;
          this.closeStatusDropdown(job.uid);
          console.log(`✅ Job status updated to ${newStatus}`);
        },
        error: (err) => {
          this.error = `Failed to update job status: ${err.message}`;
          this.updatingStatus[job.uid] = false;
          console.error('❌ Failed to update job status:', err);
        },
      });
  }

  getStatusIcon(status: JobStatus): string {
    const icons: Record<JobStatus, string> = {
      NEW: 'pi-circle',
      ACCEPTED: 'pi-check-circle',
      DECLINED: 'pi-times-circle',
      REJECTED: 'pi-ban',
      DELIVERED: 'pi-send',
      EMAILED: 'pi-envelope',
      COMPLETED: 'pi-check',
      CANCELLED: 'pi-times',
    };
    return icons[status] || 'pi-circle';
  }
}
