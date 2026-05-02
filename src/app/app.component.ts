import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  imports: [CommonModule, RouterOutlet, SidebarComponent, HlmButtonImports],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  title = 'pharse-mock-up';
  authService = inject(AuthService);

  get isLoggedIn(): boolean {
    return this.authService.isLoggedIn();
  }
}
