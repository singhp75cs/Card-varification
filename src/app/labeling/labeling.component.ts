import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  ViewChild,
  AfterViewInit,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DetectionService } from '../services/detection.service';

@Component({
  selector: 'app-labeling',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './labeling.component.html',
  styleUrls: ['./labeling.component.scss'],
  // Canvas drawing and mutable box state — keep Eager
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class LabelingComponent implements OnInit, AfterViewInit {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('image',  { static: true }) imageRef!: ElementRef<HTMLImageElement>;

  orderId = '';
  status = '';
  comment = '';
  accuracy = '';
  label = '';
  images: string[] = [];
  currentImageIndex = 0;
  labelList = ['Person', 'Car', 'Animal', 'Tree'];
  isEditable = false;
  isShowLabelDropdown = false;
  showLabelWarning = false;

  selectedLabel = '';
  ctx!: CanvasRenderingContext2D;
  isDrawing = false;
  boxes: { [key: number]: { x: number; y: number; w: number; h: number; label: string }[] } = {};
  startX = 0;
  startY = 0;

  isDetecting = false;
  detectionError = '';

  constructor(
    private route: ActivatedRoute,
    private detection: DetectionService
  ) {}

  ngOnInit(): void {
    this.route.queryParams.subscribe(params => {
      this.orderId  = params['orderId'];
      this.status   = params['status'];
      this.comment  = params['comment'];
      this.accuracy = params['accuracy'];
      this.label    = params['label'];

      const imageParam = params['image'];
      this.images = imageParam
        ? (Array.isArray(imageParam) ? imageParam : imageParam.split(','))
        : [];

      this.isEditable          = ['Pending', 'In Progress'].includes(this.status);
      this.isShowLabelDropdown = ['In Progress'].includes(this.status);

      this.images.forEach((_, index) => (this.boxes[index] = []));
    });
  }

  ngAfterViewInit(): void {
    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;
    this.resizeCanvas();

    const img = this.imageRef.nativeElement;
    img.onload = () => this.resizeCanvas();
    if (img.complete) this.resizeCanvas();
  }

  @HostListener('window:resize')
  onResize(): void {
    this.resizeCanvas();
  }

  resizeCanvas(): void {
    const canvas = this.canvasRef.nativeElement;
    const img    = this.imageRef.nativeElement;
    canvas.width  = img.clientWidth;
    canvas.height = img.clientHeight;
    this.drawBoxes();
  }

  prevImage(): void {
    if (this.currentImageIndex > 0) {
      this.currentImageIndex--;
      this.drawBoxes();
    }
  }

  nextImage(): void {
    if (this.currentImageIndex < this.images.length - 1) {
      this.currentImageIndex++;
      this.drawBoxes();
    }
  }

  startDraw(event: MouseEvent): void {
    if (!this.isEditable) return;

    if (!this.selectedLabel) {
      this.showLabelWarning = true;
      return;
    }

    this.showLabelWarning = false;
    this.isDrawing = true;

    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.startX = event.clientX - rect.left;
    this.startY = event.clientY - rect.top;
  }

  draw(event: MouseEvent): void {
    if (!this.isDrawing) return;

    const rect   = this.canvasRef.nativeElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const width  = mouseX - this.startX;
    const height = mouseY - this.startY;

    this.ctx.clearRect(0, 0, this.canvasRef.nativeElement.width, this.canvasRef.nativeElement.height);
    this.drawBoxes();

    this.ctx.strokeStyle = 'green';
    this.ctx.lineWidth   = 3;
    this.ctx.strokeRect(this.startX, this.startY, width, height);
  }

  endDraw(event: MouseEvent): void {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const endX = event.clientX - rect.left;
    const endY = event.clientY - rect.top;
    const w    = endX - this.startX;
    const h    = endY - this.startY;

    if (w && h && this.selectedLabel) {
      this.boxes[this.currentImageIndex].push({
        x: this.startX, y: this.startY, w, h,
        label: this.selectedLabel
      });
      this.drawBoxes();
    }
  }

  drawBoxes(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvasRef.nativeElement.width, this.canvasRef.nativeElement.height);

    this.boxes[this.currentImageIndex]?.forEach(box => {
      ctx.strokeStyle = 'red';
      ctx.lineWidth   = 5;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.fillStyle = 'red';
      ctx.font      = '14px Arial';
      ctx.fillText(box.label, box.x + 4, box.y - 4);
    });
  }

  saveLabeling(): void {
    const currentBoxes = this.boxes[this.currentImageIndex] || [];

    const labelsToSend = currentBoxes.length > 0
      ? currentBoxes
      : this.label
        ? [{ label: this.label, x: 0, y: 0, w: 0, h: 0 }]
        : [];

    const payload = {
      image: this.images[this.currentImageIndex],
      labels: labelsToSend
    };

    console.log('Payload for current image:', payload);

    if (currentBoxes.length === 0 && this.label) {
      alert(`No new labels drawn. Sending previous label for image ${this.currentImageIndex + 1}.`);
    } else {
      alert(`Labels saved successfully for image ${this.currentImageIndex + 1} (mock)`);
    }

    if (this.currentImageIndex === this.images.length - 1) {
      const fullPayload = this.images.map((image, index) => ({
        image,
        labels: this.boxes[index]?.length > 0
          ? this.boxes[index]
          : this.label
            ? [{ label: this.label, x: 0, y: 0, w: 0, h: 0 }]
            : []
      }));
      console.log('Submitting all images with labels:', fullPayload);
      alert('All images processed and submitted (mock)');
    }
  }

  cancel(): void {
    this.boxes[this.currentImageIndex] = [];
    this.drawBoxes();
  }

  async runDetection(): Promise<void> {
    if (!this.isEditable || this.isDetecting) return;

    const src = this.images[this.currentImageIndex];
    if (!src) {
      this.detectionError = 'No image available to detect.';
      return;
    }

    this.isDetecting = true;
    this.detectionError = '';

    try {
      // fetch handles data/asset/remote URLs the same way.
      const resp = await fetch(src);
      const blob = await resp.blob();

      const result = await firstValueFrom(
        this.detection.detectImage(blob, this.orderId)
      );

      // Treat model output as untrusted: guard empty/missing lists.
      const detections = result?.detections ?? [];
      const canvas = this.canvasRef.nativeElement;

      if (!this.boxes[this.currentImageIndex]) {
        this.boxes[this.currentImageIndex] = [];
      }

      for (const box of detections) {
        if (!box) continue;
        if (
          !Number.isFinite(box.x) ||
          !Number.isFinite(box.y) ||
          !Number.isFinite(box.width) ||
          !Number.isFinite(box.height)
        ) {
          continue;
        }

        const pxX = box.x * canvas.width;
        const pxY = box.y * canvas.height;
        const pxW = box.width * canvas.width;
        const pxH = box.height * canvas.height;

        this.boxes[this.currentImageIndex].push({
          x: pxX,
          y: pxY,
          w: pxW,
          h: pxH,
          label: box.label ?? ''
        });
      }

      this.drawBoxes();
    } catch (err: any) {
      const statusCode = err?.status;
      if (statusCode === 401) {
        this.detectionError = 'Not authorized. Please log in again.';
      } else if (statusCode === 503) {
        this.detectionError = 'Detection model unavailable. Try again shortly.';
      } else {
        this.detectionError = 'Could not reach the detection service.';
      }
    } finally {
      this.isDetecting = false;
    }
  }
}
