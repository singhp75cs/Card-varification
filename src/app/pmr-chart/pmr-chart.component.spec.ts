import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PMRChartComponent } from './pmr-chart.component';

describe('PMRChartComponent', () => {
  let component: PMRChartComponent;
  let fixture: ComponentFixture<PMRChartComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ PMRChartComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PMRChartComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
