import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import {
  PhraseApiService,
  ProjectDetail,
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
  loading = false;
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
      },
      error: (err) => {
        this.error = err.message;
        this.loading = false;
        console.error('Failed to load project:', err);
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
      case 'ACTIVE':
        return 'success';
      case 'COMPLETED':
        return 'success';
      case 'ARCHIVED':
        return 'warning';
      default:
        return 'info';
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
