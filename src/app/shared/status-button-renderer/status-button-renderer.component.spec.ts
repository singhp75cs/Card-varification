import { ComponentFixture, TestBed } from '@angular/core/testing';

import { StatusButtonRendererComponent } from './status-button-renderer.component';

describe('StatusButtonRendererComponent', () => {
  let component: StatusButtonRendererComponent;
  let fixture: ComponentFixture<StatusButtonRendererComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ StatusButtonRendererComponent ]
    })
    .compileComponents();

    fixture = TestBed.createComponent(StatusButtonRendererComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
