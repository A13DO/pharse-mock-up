import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';

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
  ],
  templateUrl: './data-table.component.html',
  styleUrl: './data-table.component.scss',
})
export class DataTableComponent {
  @Input() columns: TableColumn[] = [];
  @Input() tableData: any[] = [];
  @Input() loading = false;
  @Input() emptyMessage = 'No data available';
  @Input() totalRecords = 0;
  @Input() rowsPerPage = 10;
  @Output() viewRow = new EventEmitter<any>();

  selectedRows: any[] = [];

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
}
