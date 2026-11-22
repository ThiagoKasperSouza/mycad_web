import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { planeFromFace, type BodyInfo, type Plane } from './model';

export interface FaceSelection {
  plane: Plane;
  bodyId: number;
  point: THREE.Vector3;
}

/** Viewport 3D: cena, órbita, corpos extrudados e seleção de face. */
export class ThreeViewport {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private bodies = new Map<number, THREE.Mesh>();
  private highlight?: THREE.Mesh;
  private down?: { x: number; y: number };
  private running = false;

  constructor(private container: HTMLElement, private onFaceSelected: (s: FaceSelection) => void) {
    this.scene.background = new THREE.Color(0x0b0f15);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(120, 90, 160);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(80, 140, 120);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x88aaff, 0.6);
    dir2.position.set(-100, -50, -80);
    this.scene.add(dir2);

    const grid = new THREE.GridHelper(400, 40, 0x33455c, 0x1b2532);
    grid.position.y = -0.01;
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(30);
    this.scene.add(axes);

    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (!this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = undefined;
      if (moved > 5 || e.button !== 0) return;
      this.pickFace(e);
    });
  }

  private pickFace(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.bodies.values()].filter((m) => m.visible);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;
    const hit = hits[0];
    const face = hit.face;
    if (!face) return;

    const mesh = hit.object as THREE.Mesh;
    const normal = face.normal.clone().transformDirection(mesh.matrixWorld);
    const bodyId = [...this.bodies.entries()].find(([, m]) => m === mesh)?.[0];
    if (bodyId === undefined) return;

    this.highlightFace(mesh, face, mesh.matrixWorld);
    this.onFaceSelected({ plane: planeFromFace(hit.point, normal), bodyId, point: hit.point.clone() });
  }

  private highlightFace(mesh: THREE.Mesh, face: THREE.Face, matrix: THREE.Matrix4): void {
    if (this.highlight) {
      this.scene.remove(this.highlight);
      this.highlight.geometry.dispose();
      (this.highlight.material as THREE.Material).dispose();
    }
    const pos = mesh.geometry.getAttribute('position');
    const verts = [face.a, face.b, face.c].map((i) =>
      new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(matrix));
    const geo = new THREE.BufferGeometry().setFromPoints(verts);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4da3ff, transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.highlight = new THREE.Mesh(geo, mat);
    this.highlight.renderOrder = 2;
    this.scene.add(this.highlight);
  }

  clearHighlight(): void {
    if (!this.highlight) return;
    this.scene.remove(this.highlight);
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.highlight = undefined;
  }

  addBody(body: BodyInfo): void {
    this.bodies.set(body.id, body.mesh);
    this.scene.add(body.mesh);
    this.focusAll();
  }

  setBodyVisible(id: number, visible: boolean): void {
    const mesh = this.bodies.get(id);
    if (mesh) mesh.visible = visible;
  }

  removeBody(id: number): void {
    const mesh = this.bodies.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.bodies.delete(id);
  }

  focusAll(): void {
    const box = new THREE.Box3();
    for (const mesh of this.bodies.values()) box.expandByObject(mesh);
    if (box.isEmpty()) {
      this.camera.position.set(120, 90, 160);
      this.controls.target.set(0, 0, 0);
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 100;
    const dir = new THREE.Vector3(1, 0.8, 1.2).normalize().multiplyScalar(size * 0.9);
    this.camera.position.copy(center).add(dir);
    this.controls.target.copy(center);
    this.controls.update();
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(): void {
    this.container.hidden = false;
    this.resize();
    if (!this.running) {
      this.running = true;
      const loop = () => {
        if (!this.running) return;
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  hide(): void {
    this.container.hidden = true;
    this.running = false;
  }
}
