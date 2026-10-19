import { TestBed } from '@angular/core/testing';

import { StatusChartService } from './status-chart.service';

describe('StatusChartService', () => {
  let service: StatusChartService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(StatusChartService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
