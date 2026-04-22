import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: '/projects', pathMatch: 'full' },
  {
    path: 'projects',
    loadComponent: () =>
      import('./features/projects/projects-list/projects-list.component').then(
        (m) => m.ProjectsListComponent,
      ),
  },
  {
    path: 'projects/create',
    loadComponent: () =>
      import('./features/projects/project-create/project-create.component').then(
        (m) => m.ProjectCreateComponent,
      ),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings.component').then(
        (m) => m.SettingsComponent,
      ),
  },
  { path: '**', redirectTo: '/projects' },
];
