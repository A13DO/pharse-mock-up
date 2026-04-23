import { Component, inject, OnInit } from '@angular/core';
import { CommonModule, formatDate } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import {
  PhraseApiService,
  ProjectDetail,
  Job,
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
      case 'EMAILED':
        return 'bg-yellow-100 text-yellow-800';
      case 'COMPLETED':
        return 'bg-green-100 text-green-800';
      case 'DECLINED':
      case 'CANCELLED':
        return 'bg-red-100 text-red-800';
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
}
