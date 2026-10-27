#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
3輪独立ステアリング（差動ステアリング足回り）ロボット 手動操縦 Behavior

参照仕様:
  - 3輪独立ステアリングロボットの運動学.md
  - 差動ステアリング機構.md

操作:
  - 左スティック X (axis 0) : Vx  右方向速度 [mm/s]
  - 左スティック Y (axis 1) : Vy  前方向速度 [mm/s]  (スティック上で前進)
  - 右スティック X (axis 2) : omega 角速度 [deg/s]  (右倒しで右回転)

ハードウェア割り当て (profiles/hoge.json):
  - MDD1 : タイヤ1 (前方)
  - MDD2 : タイヤ2 (右後方)
  - MDD3 : タイヤ3 (左後方)
  各MDD:
    m1 = モーター M1 (速度モード, Encoder 1)
    m2 = モーター M2 (速度モード, Encoder 2)
    m3 = Encoder 3 (ステアリング角度。モーターは接続しない / 出力0)
    m4 = 未使用

制御の流れ (差動ステアリング機構.md 9章):
  1. ゲームパッドから Vx, Vy, omega_deg を生成
  2. 逆運動学で各タイヤの (V_target_i, theta_target_i) を算出
  3. Encoder 3 の角度から最短角度誤差を計算 (180度反転の等価解も利用)
  4. 角度PID -> 目標ステアリング角速度 steer_rate_target_i
  5. (V_target_i, steer_rate_target_i) -> M1, M2 の目標回転数 [rps]
  6. MDD の速度PID (Encoder 1・2) が M1, M2 を速度制御
"""

import sys
import os
import math
import time
import rclpy

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from altair_core.base_behavior import AltairBehavior


# =====================================================================
# パラメータ
# =====================================================================

# --- 制御周期 ---
CONTROL_RATE_HZ = 100.0

# --- 操縦入力 ---
AXIS_VX = 0                 # 左スティック X
AXIS_VY = 1                 # 左スティック Y (上で負の値)
AXIS_OMEGA = 2              # 右スティック X
V_MAX = 800.0               # スティック最大時の並進速度 [mm/s]
OMEGA_MAX = 90.0            # スティック最大時の角速度 [deg/s]
STICK_DEADZONE = 0.08       # スティックのデッドゾーン (Web側の0.05に加えて)
GAMEPAD_TIMEOUT = 0.5       # この時間ゲームパッド入力が来なければ停止 [s]

# --- ロボット幾何 (運動学.md 2章) ---
# (x_i, y_i) [mm]  右が +X, 前が +Y
WHEEL_POSITIONS = [
    (0.0, 190.53),          # タイヤ1：前方
    (165.00, -95.265),      # タイヤ2：右後方
    (-165.00, -95.265),     # タイヤ3：左後方
]
WHEEL_DIAMETER = 70.0       # [mm]

# --- 差動ステアリング機構の換算係数 (差動ステアリング機構.md 3,4章) ---
# n_wheel = DRIVE_RATIO * (n1 - n2)        (M1,M2逆方向1回転ずつ -> タイヤ0.875回転)
DRIVE_RATIO = 0.4375
# steer_rate[deg/s] = STEER_DEG_PER_REV_SUM * (n1 + n2)[rps]
#   (M1,M2同方向1回転ずつ -> ステア180度)  => 180 / 2 = 90 deg per (rev-sum)
#   ※ RPM 基準では 1.5 deg/s per RPM-sum と等価
STEER_DEG_PER_REV_SUM = 90.0

# --- MDD チャンネル割り当て (0始まりインデックス) ---
MDD_NAMES = ["MDD1", "MDD2", "MDD3"]
CH_M1 = 0
CH_M2 = 1
CH_ENC3 = 2

# --- 符号・オフセット補正 (差動ステアリング機構.md 10章の試験結果で調整) ---
# DRIVE_SIGN : 正の V でタイヤが theta 方向へ進まない場合は -1
# STEER_SIGN : 正の steer_rate で右回り(上から見て時計回り)にならない場合は -1
# ENC3_SIGN  : Encoder 3 の角度が右回りで増加しない場合は -1
# ENC3_OFFSET: タイヤが前方 (+Y) を向いているときの Encoder 3 の生値 [deg]
DRIVE_SIGN = [1.0, 1.0, 1.0]
STEER_SIGN = [1.0, 1.0, 1.0]
ENC3_SIGN = [1.0, 1.0, 1.0]
ENC3_OFFSET = [0.0, 0.0, 0.0]

# --- ステアリング角度PID (出力: deg/s) ---
STEER_KP = 6.0              # [deg/s per deg]
STEER_KI = 0.0              # [deg/s per (deg*s)]
STEER_KD = 0.0              # [deg/s per (deg/s)]  (測定値微分)
STEER_I_LIMIT = 60.0        # 積分項の上限 [deg/s]
STEER_RATE_MAX = 540.0      # ステアリング角速度上限 [deg/s]

# --- ステアリング・駆動の協調 (差動ステアリング機構.md 7.1, 8章) ---
USE_FLIP_OPTIMIZATION = True    # (V, θ) と (-V, θ+180) の近い方を選ぶ
FLIP_HYSTERESIS = 10.0          # 反転判定のヒステリシス [deg]
DRIVE_COS_SCALING = True        # 角度誤差 e に対し V *= cos(e) で駆動を抑制
DRIVE_ENABLE_ERROR = 45.0       # 角度誤差がこれを超える間は駆動速度0 [deg]
V_EPS = 5.0                     # これ未満の速度は停止扱い、ステア角を保持 [mm/s]

# --- モーター上限 ---
MOTOR_RPS_MAX = 20.0        # M1, M2 の目標回転数上限 [rps]

# --- ログ ---
LOG_INTERVAL = 1.0          # [s]


# =====================================================================
# ユーティリティ
# =====================================================================

def wrap_to_180(angle_deg):
    """角度を [-180, +180) に正規化する。"""
    return (angle_deg + 180.0) % 360.0 - 180.0


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def apply_deadzone(x, dz):
    """デッドゾーン適用後、残りの範囲を 0〜1 に再スケールする。"""
    if abs(x) < dz:
        return 0.0
    return math.copysign((abs(x) - dz) / (1.0 - dz), x)


# =====================================================================
# 運動学
# =====================================================================

def inverse_kinematics(vx, vy, omega_deg):
    """
    ロボット中心速度から各タイヤの (速度 [mm/s], ステア角 [deg]) を求める。
    角度は前方 (+Y) を 0 度, 右 (+X) を +90 度とする。
    速度がほぼ0のタイヤは角度 None を返す。
    """
    omega = math.radians(omega_deg)
    result = []
    for (x_i, y_i) in WHEEL_POSITIONS:
        vx_i = vx + omega * y_i
        vy_i = vy - omega * x_i
        v_i = math.hypot(vx_i, vy_i)
        if v_i < V_EPS:
            result.append((0.0, None))
        else:
            result.append((v_i, math.degrees(math.atan2(vx_i, vy_i))))
    return result


def differential_mix(v_wheel, steer_rate):
    """
    目標タイヤ速度 [mm/s] と目標ステアリング角速度 [deg/s] から
    M1, M2 の目標回転数 [rps] を求める (差動ステアリング機構.md 5章)。
    """
    n_wheel = v_wheel / (math.pi * WHEEL_DIAMETER)      # [rps]
    diff = n_wheel / DRIVE_RATIO                        # n1 - n2
    total = steer_rate / STEER_DEG_PER_REV_SUM          # n1 + n2
    n1 = 0.5 * (total + diff)
    n2 = 0.5 * (total - diff)

    # 上限を超える場合は比率を保ったまま縮小する
    peak = max(abs(n1), abs(n2))
    if peak > MOTOR_RPS_MAX:
        scale = MOTOR_RPS_MAX / peak
        n1 *= scale
        n2 *= scale
    return n1, n2


# =====================================================================
# ステアリング角度PID
# =====================================================================

class SteerPID:
    def __init__(self):
        self.reset()

    def reset(self):
        self.integral = 0.0
        self.prev_measured = None

    def update(self, error_deg, measured_deg, dt):
        # 積分 (アンチワインドアップ)
        if STEER_KI > 0.0:
            self.integral += STEER_KI * error_deg * dt
            self.integral = clamp(self.integral, -STEER_I_LIMIT, STEER_I_LIMIT)

        # 微分 (目標の反転による跳ねを避けるため測定値の微分を使用)
        d_term = 0.0
        if self.prev_measured is not None and dt > 0.0:
            d_meas = wrap_to_180(measured_deg - self.prev_measured) / dt
            d_term = -STEER_KD * d_meas
        self.prev_measured = measured_deg

        out = STEER_KP * error_deg + self.integral + d_term
        return clamp(out, -STEER_RATE_MAX, STEER_RATE_MAX)


# =====================================================================
# 足回りモジュール 1輪分
# =====================================================================

class SwerveModule:
    def __init__(self, index, mdd):
        self.index = index
        self.mdd = mdd
        self.pid = SteerPID()
        self.hold_theta = None      # 保持しているステア目標角 [deg]
        self.flipped = False        # (−V, θ+180) を採用中か

        # ログ用
        self.last = {}

    def measured_angle(self):
        """Encoder 3 から現在のステアリング角度 [deg] (前方0, 右回り正) を取得。"""
        raw = self.mdd.get_feedback().angles[CH_ENC3]
        return wrap_to_180(ENC3_SIGN[self.index] * (raw - ENC3_OFFSET[self.index]))

    def is_running(self):
        return self.mdd.get_feedback().system_status == 1

    def stop(self):
        self.mdd.set_targets([0.0, 0.0, 0.0, 0.0])

    def reset(self):
        self.pid.reset()
        self.hold_theta = None
        self.flipped = False

    def update(self, v_target, theta_target, dt):
        i = self.index
        theta_meas = self.measured_angle()

        # 速度が小さいときは角度を前回値に保持 (初回は現在角)
        if theta_target is None:
            if self.hold_theta is None:
                self.hold_theta = theta_meas
            theta_target = self.hold_theta
            v_target = 0.0
        else:
            self.hold_theta = theta_target

        # 180度反転の等価解: 移動量が小さい方を採用 (ヒステリシス付き)
        v_cmd = v_target
        theta_cmd = theta_target
        if USE_FLIP_OPTIMIZATION:
            theta_cur = theta_target + (180.0 if self.flipped else 0.0)
            err_cur = wrap_to_180(theta_cur - theta_meas)
            if abs(err_cur) > 90.0 + FLIP_HYSTERESIS:
                self.flipped = not self.flipped
            if self.flipped:
                theta_cmd = theta_target + 180.0
                v_cmd = -v_target

        error = wrap_to_180(theta_cmd - theta_meas)

        # 角度PID -> ステアリング角速度
        steer_rate = self.pid.update(error, theta_meas, dt)

        # ステア誤差が大きい間は駆動を抑制
        if abs(error) > DRIVE_ENABLE_ERROR:
            v_cmd = 0.0
        elif DRIVE_COS_SCALING:
            v_cmd *= max(0.0, math.cos(math.radians(error)))

        # 差動合成 -> M1, M2 [rps]
        n1, n2 = differential_mix(
            DRIVE_SIGN[i] * v_cmd,
            STEER_SIGN[i] * steer_rate,
        )

        targets = [0.0, 0.0, 0.0, 0.0]
        targets[CH_M1] = n1
        targets[CH_M2] = n2
        self.mdd.set_targets(targets)

        self.last = {
            "theta_t": wrap_to_180(theta_cmd), "theta_m": theta_meas, "err": error,
            "v": v_cmd, "rate": steer_rate, "n1": n1, "n2": n2,
        }


# =====================================================================
# Behavior 本体
# =====================================================================

class IndependentDifferentialSteering(AltairBehavior):
    def on_init(self):
        self.get_logger().info("3輪独立差動ステアリング Behavior を初期化します。")
        self.wheels = [
            SwerveModule(i, self.get_module(name))
            for i, name in enumerate(MDD_NAMES)
        ]
        self.last_gamepad_time = 0.0
        self.prev_time = time.monotonic()
        self.last_log_time = 0.0
        self.was_active = False

    # ゲームパッド受信時刻を記録してタイムアウト検知に使う
    def _gamepad_callback(self, msg):
        super()._gamepad_callback(msg)
        self.last_gamepad_time = time.monotonic()

    def read_command(self):
        """ゲームパッドから (Vx, Vy, omega_deg) を生成する。"""
        lx = apply_deadzone(self.gamepad.get_axis(AXIS_VX), STICK_DEADZONE)
        ly = apply_deadzone(self.gamepad.get_axis(AXIS_VY), STICK_DEADZONE)
        rx = apply_deadzone(self.gamepad.get_axis(AXIS_OMEGA), STICK_DEADZONE)

        vx = lx * V_MAX
        vy = -ly * V_MAX            # スティック上 (負) で前進
        omega_deg = rx * OMEGA_MAX  # 右倒しで右回転 (正)

        # 斜め入力で V_MAX を超えないように制限
        v = math.hypot(vx, vy)
        if v > V_MAX:
            vx *= V_MAX / v
            vy *= V_MAX / v
        return vx, vy, omega_deg

    def stop_all(self):
        for w in self.wheels:
            w.stop()
            w.pid.reset()

    def loop(self):
        now = time.monotonic()
        dt = clamp(now - self.prev_time, 0.0, 0.1)
        self.prev_time = now

        # 安全条件: ゲームパッドが途絶 / MDD が制御実行中でない
        gamepad_alive = (now - self.last_gamepad_time) < GAMEPAD_TIMEOUT
        mdd_running = all(w.is_running() for w in self.wheels)

        if not (gamepad_alive and mdd_running):
            if self.was_active:
                reason = "ゲームパッド途絶" if not gamepad_alive else "MDD 非実行状態"
                self.get_logger().warn(f"停止します ({reason})")
            self.stop_all()
            for w in self.wheels:
                w.reset()
            self.was_active = False
            return

        if not self.was_active:
            self.get_logger().info("制御を開始します。")
            self.was_active = True

        vx, vy, omega_deg = self.read_command()
        wheel_cmds = inverse_kinematics(vx, vy, omega_deg)

        for w, (v_i, theta_i) in zip(self.wheels, wheel_cmds):
            w.update(v_i, theta_i, dt)

        if now - self.last_log_time >= LOG_INTERVAL:
            self.last_log_time = now
            parts = [f"cmd Vx={vx:.0f} Vy={vy:.0f} w={omega_deg:.1f}"]
            for w in self.wheels:
                s = w.last
                parts.append(
                    f"T{w.index + 1}[θt={s['theta_t']:.1f} θm={s['theta_m']:.1f} "
                    f"e={s['err']:.1f} V={s['v']:.0f} n1={s['n1']:.2f} n2={s['n2']:.2f}]"
                )
            self.get_logger().info(" ".join(parts))

    def destroy_node(self):
        # 終了時にモーターを停止
        try:
            self.stop_all()
        except Exception:
            pass
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    behavior = IndependentDifferentialSteering("independent_differential_steering_node")
    behavior.run(rate_hz=CONTROL_RATE_HZ)


if __name__ == '__main__':
    main()
