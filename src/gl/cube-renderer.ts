/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mat4 } from 'gl-matrix'
import type { XRFrame, XRPose, XRView } from 'webxr'
import XRCubeLayer from '../api/XRCubeLayer'
import { XRSessionWithLayer } from '../api/XRSessionWithLayer'
import { XRLayerLayout, XRWebGLRenderingContext } from '../types'
import { LayerRenderer } from './base-renderer'
import { createProgram } from './webgl-utils'

// template tagging for syntax highlight
const glsl = (x) => x

const vertexShader = glsl`
attribute vec4 a_position;
uniform mat4 u_projectionMatrix;
uniform mat4 u_matrix;
varying vec3 v_normal;

void main() {
   gl_Position = u_projectionMatrix * u_matrix * a_position;

   v_normal = normalize(a_position.xyz);
}
`

const fragmentShader = glsl`
precision mediump float;

varying vec3 v_normal;

uniform samplerCube u_texture;

void main() {
   gl_FragColor = textureCube(u_texture, normalize(v_normal));
}
`

type CubeProgramInfo = {
	attribLocations: {
		a_position: number
	}
	uniformLocations: {
		u_matrix: WebGLUniformLocation
		u_texture: WebGLUniformLocation
		u_projectionMatrix: WebGLUniformLocation
	}
}

// see https://webglfundamentals.org/webgl/lessons/webgl-cube-maps.html
// and https://github.com/xdsopl/webgl/blob/master/cubemap.html
export class CubeRenderer implements LayerRenderer {
	protected gl: XRWebGLRenderingContext
	protected transformMatrix: mat4

	protected positionBuffer: WebGLBuffer

	protected layer: XRCubeLayer
	protected program: WebGLProgram

	private programInfo: CubeProgramInfo
	private positionPoints: Float32Array

	constructor(layer: XRCubeLayer, gl: XRWebGLRenderingContext) {
		this.layer = layer
		this.gl = gl

		this.transformMatrix = mat4.create()

		// create the program
		this.program = createProgram(gl, vertexShader, fragmentShader)

		// create program info
		this.programInfo = {
			attribLocations: {
				a_position: gl.getAttribLocation(this.program, 'a_position'),
			},
			uniformLocations: {
				u_matrix: gl.getUniformLocation(this.program, 'u_matrix'),
				u_texture: gl.getUniformLocation(this.program, 'u_texture'),
				u_projectionMatrix: gl.getUniformLocation(this.program, 'u_projectionMatrix'),
			},
		}
	}

	public render(session: XRSessionWithLayer, frame: XRFrame) {
		let gl = this.gl

		let baseLayer = session.getBaseLayer()
		let basePose = frame.getViewerPose(session.getReferenceSpace())

		for (let view of basePose.views) {
			let viewport = baseLayer.getViewport(view)
			gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height)

			gl.activeTexture(gl.TEXTURE0)
			// STEREO CASE: 0 is left eye, 1 is right eye
			if (this.layer.layout === XRLayerLayout.stereo) {
				const index = view.eye === 'right' ? 1 : 0
				gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.layer.colorTextures[index])
			} else {
				gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.layer.colorTextures[0])
			}

			gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
			gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR)

			this._renderInternal(this.layer.orientation, view)
		}
	}

	// override this to set position values!
	createPositionPoints(): Float32Array {
		const w = 0.5
		// prettier-ignore
		const positions = [
         -w, -w,  -w,
         -w,  w,  -w,
          w, -w,  -w,
         -w,  w,  -w,
          w,  w,  -w,
          w, -w,  -w,
     
         -w, -w,   w,
          w, -w,   w,
         -w,  w,   w,
         -w,  w,   w,
          w, -w,   w,
          w,  w,   w,
     
         -w,   w, -w,
         -w,   w,  w,
          w,   w, -w,
         -w,   w,  w,
          w,   w,  w,
          w,   w, -w,
     
         -w,  -w, -w,
          w,  -w, -w,
         -w,  -w,  w,
         -w,  -w,  w,
          w,  -w, -w,
          w,  -w,  w,
     
         -w,  -w, -w,
         -w,  -w,  w,
         -w,   w, -w,
         -w,  -w,  w,
         -w,   w,  w,
         -w,   w, -w,
     
          w,  -w, -w,
          w,   w, -w,
          w,  -w,  w,
          w,  -w,  w,
          w,   w, -w,
          w,   w,  w,
      ]
		return new Float32Array(positions)
	}

	_poseOrientationMatrix: mat4
	_renderInternal(orientation: DOMPointReadOnly, view: XRView) {
		let gl = this.gl

		if (!this.positionBuffer) {
			this._initBuffers()
			this._setBuffers(true)
		}

		// Tell it to use our program (pair of shaders)
		gl.useProgram(this.program)
		this._setBuffers()

		// MATRIX
		// set matrix

		// apply only the orientation of the pose and the layer to the transform matrix.
		mat4.fromQuat(this.transformMatrix, [
			orientation.x,
			orientation.y,
			orientation.z,
			orientation.w,
		])
		if (!this._poseOrientationMatrix) {
			this._poseOrientationMatrix = mat4.create()
		}
		mat4.fromQuat(this._poseOrientationMatrix, [
			view.transform.inverse.orientation.x,
			view.transform.inverse.orientation.y,
			view.transform.inverse.orientation.z,
			view.transform.inverse.orientation.w,
		])
		mat4.multiply(this.transformMatrix, this.transformMatrix, this._poseOrientationMatrix)
		gl.uniformMatrix4fv(this.programInfo.uniformLocations.u_matrix, false, this.transformMatrix)
		gl.uniformMatrix4fv(
			this.programInfo.uniformLocations.u_projectionMatrix,
			false,
			view.projectionMatrix
		)

		// TEXTURE
		// Tell the shader to use texture unit 0 for u_texture
		gl.uniform1i(this.programInfo.uniformLocations.u_texture, 0)

		// Draw the shape
		var primitiveType = gl.TRIANGLES
		var offset = 0
		var count = this.positionPoints.length / 3
		gl.drawArrays(primitiveType, offset, count)
	}

	_initBuffers() {
		let gl = this.gl

		// A_POSITION
		// Create a buffer to put three 2d clip space points in
		this.positionBuffer = gl.createBuffer()
	}

	_recalculateVertices() {
		this.positionPoints = this.createPositionPoints()
	}

	_setBuffers(shouldResetData?: boolean) {
		if (shouldResetData) {
			this._recalculateVertices()
		}

		let gl = this.gl
		// Turn on the position attribute
		gl.enableVertexAttribArray(this.programInfo.attribLocations.a_position)

		// Bind the position buffer.
		gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer)

		if (shouldResetData) {
			const positions = this.positionPoints
			gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
		}

		// Tell the position attribute how to get data out of positionBuffer (ARRAY_BUFFER)
		var size = 3 // 3 components per iteration
		var type = gl.FLOAT // the data is 32bit floats
		var normalize = false // don't normalize the data
		var stride = 0 // 0 = move forward size * sizeof(type) each iteration to get the next position
		var offset = 0 // start at the beginning of the buffer
		gl.vertexAttribPointer(
			this.programInfo.attribLocations.a_position,
			size,
			type,
			normalize,
			stride,
			offset
		)
	}
}