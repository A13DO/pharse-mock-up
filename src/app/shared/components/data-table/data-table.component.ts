import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { SkeletonModule } from 'primeng/skeleton';
import { HlmTooltipImports } from '@spartan-ng/helm/tooltip';

export interface TableColumn {
  field?: string;
  key?: string;
  header?: string;
  label?: string;
  format?: (value: any) => string;
  sortable?: boolean;
}

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [
    CommonModule,
    TableModule,
    PaginatorModule,
    ButtonModule,
    CheckboxModule,
    SkeletonModule,
    HlmTooltipImports,
  ],
  templateUrl: './data-table.component.html',
  styleUrl: './data-table.component.scss',
})
export class DataTableComponent implements OnChanges {
  @Input() columns: TableColumn[] = [];
  @Input() tableData: any[] = [];
  @Input() loading = false;
  @Input() emptyMessage = 'No data available';
  @Input() totalRecords = 0;
  @Input() rowsPerPage = 10;
  @Output() viewRow = new EventEmitter<any>();

  selectedRows: any[] = [];
  skeletonRows: any[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['loading'] && this.loading) {
      // Generate skeleton rows when loading starts
      this.skeletonRows = Array.from({ length: 15 }).map((_, i) => ({
        id: `skeleton-${i}`,
      }));
    }
  }

  getFieldName(column: TableColumn): string {
    return column.field || column.key || '';
  }

  getHeaderName(column: TableColumn): string {
    return column.header || column.label || '';
  }

  getCellValue(row: any, column: TableColumn): string {
    const fieldName = this.getFieldName(column);
    const value = this.getNestedValue(row, fieldName);
    return column.format ? column.format(value) : (value ?? '-');
  }

  onViewClick(row: any): void {
    this.viewRow.emit(row);
  }

  onPageChange(event: PaginatorState) {
    // Handle pagination logic here
    console.log('Page changed:', event);
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, prop) => current?.[prop], obj);
  }

  getStatusBadgeClass(status: string): string {
    if (!status) return 'bg-gray-100 text-gray-700';

    const statusLower = status.toLowerCase();

    switch (statusLower) {
      case 'completed':
        return 'bg-green-100 text-green-700';
      case 'in_progress':
      case 'in progress':
        return 'bg-blue-100 text-blue-700';
      case 'pending':
        return 'bg-yellow-100 text-yellow-700';
      case 'failed':
        return 'bg-red-100 text-red-700';
      case 'active':
        return 'bg-emerald-100 text-emerald-700';
      case 'inactive':
        return 'bg-slate-100 text-slate-700';
      default:
        return 'bg-slate-100 text-slate-700';
    }
  }
}
