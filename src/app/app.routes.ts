import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { loginGuard } from './core/guards/login.guard';

export const routes: Routes = [
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  {
    path: 'login',
    canActivate: [loginGuard],
    loadComponent: () =>
      import('./features/auth/login/login.component').then(
        (m) => m.LoginComponent,
      ),
  },
  {
    path: 'projects',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/projects/projects-list/projects-list.component').then(
        (m) => m.ProjectsListComponent,
      ),
  },
  {
    path: 'projects/create',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/projects/project-create/project-create.component').then(
        (m) => m.ProjectCreateComponent,
      ),
  },
  {
    path: 'projects/:uid',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/projects/project-detail/project-detail.component').then(
        (m) => m.ProjectDetailComponent,
      ),
  },
  {
    path: 'projects/:uid/jobs/create',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/projects/job-create/job-create.component').then(
        (m) => m.JobCreateComponent,
      ),
  },
  {
    path: 'translate/:projectUid/:jobUid',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/translation/translation.component').then(
        (m) => m.TranslationComponent,
      ),
  },
  {
    path: 'ai-translate',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./translation/translation.component').then(
        (m) => m.TranslationComponent,
      ),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/settings/settings.component').then(
        (m) => m.SettingsComponent,
      ),
  },
  { path: '**', redirectTo: '/login' },
];
