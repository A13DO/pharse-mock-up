import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import {
  PhraseApiService,
  Project,
} from '../../../core/services/phrase-api.service';
import {
  DataTableComponent,
  TableColumn,
} from '../../../shared/components/data-table/data-table.component';
import { HeaderComponent } from '../../../layout/header/header.component';

@Component({
  selector: 'app-projects-list',
  standalone: true,
  imports: [CommonModule, RouterModule, DataTableComponent, HeaderComponent],
  templateUrl: './projects-list.component.html',
  styleUrl: './projects-list.component.scss',
})
export class ProjectsListComponent implements OnInit {
  private phraseApi = inject(PhraseApiService);

  projects: Project[] = [];
  loading = false;
  error: string | null = null;

  columns: TableColumn[] = [
    { key: 'uid', label: 'UID' },
    { key: 'name', label: 'Name' },
    { key: 'sourceLang', label: 'Source Language' },
    { key: 'status', label: 'Status' },
    {
      key: 'dateDue',
      label: 'Due Date',
      format: (value: string) =>
        value ? new Date(value).toLocaleDateString() : '-',
    },
    {
      key: 'createdBy.userName',
      label: 'Created By',
    },
  ];

  ngOnInit(): void {
    this.loadProjects();
  }

  loadProjects(): void {
    this.loading = true;
    this.error = null;

    this.phraseApi.getProjects().subscribe({
      next: (response) => {
        this.projects = response.content || [];
        this.loading = false;
      },
      error: (err) => {
        this.error = err.message;
        this.loading = false;
        console.error('Failed to load projects:', err);
      },
    });
  }

  refresh(): void {
    this.loadProjects();
  }
}
