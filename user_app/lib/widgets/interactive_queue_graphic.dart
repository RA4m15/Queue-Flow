import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../core/theme/app_theme.dart';

/// An interactive mini-game designed for users to play while waiting in line.
///
/// Features:
/// - "Queue Jumper": An arcade runner game where the player controls an energetic
///   queue token, jumping over bureaucracy hurdles and collecting bonus speed-passes.
/// - 60 FPS smooth physics with single and double-jump mechanics.
/// - Particle sparkle effects on collecting bonus items.
/// - Live wait-time & token status banner integrated into the game HUD.
/// - Mode toggle between "Arcade Game" and "Queue Radar" so users have both experiences.
class InteractiveQueueGraphic extends StatefulWidget {
  const InteractiveQueueGraphic({
    super.key,
    this.tokenCode = 'A-104',
    this.position = 3,
    this.peopleAhead = 2,
    this.servingToken = 'A-102',
    this.counterName = 'Counter 1',
    this.waitMinutes = 6,
    this.status = 'WAITING',
    this.isDemo = false,
  });

  final String tokenCode;
  final int position;
  final int peopleAhead;
  final String servingToken;
  final String counterName;
  final int waitMinutes;
  final String status;
  final bool isDemo;

  @override
  State<InteractiveQueueGraphic> createState() => _InteractiveQueueGraphicState();
}

class _InteractiveQueueGraphicState extends State<InteractiveQueueGraphic>
    with SingleTickerProviderStateMixin {
  bool _showArcadeGame = true;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: AppColors.primary.withValues(alpha: 0.4),
          width: 1.5,
        ),
        boxShadow: [
          BoxShadow(
            color: AppColors.primary.withValues(alpha: 0.08),
            blurRadius: 20,
            spreadRadius: 2,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // ─── TOP BAR: TITLE & MODE TOGGLE ────────────────────────
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(
                    Icons.sports_esports_rounded,
                    color: AppColors.primary,
                    size: 18,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Text(
                            'WAITING ROOM ARCADE',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.bold,
                              letterSpacing: 0.5,
                              color: AppColors.textPrimary,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
                            decoration: BoxDecoration(
                              color: AppColors.secondary.withValues(alpha: 0.2),
                              borderRadius: BorderRadius.circular(4),
                            ),
                            child: const Text(
                              'PLAYABLE',
                              style: TextStyle(
                                fontSize: 9,
                                fontWeight: FontWeight.bold,
                                color: AppColors.secondary,
                              ),
                            ),
                          ),
                        ],
                      ),
                      Text(
                        'Pass time while you wait in line!',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: AppColors.textSecondary,
                              fontSize: 11,
                            ),
                      ),
                    ],
                  ),
                ),
                // Toggle between Arcade Game and Flow Radar
                Container(
                  padding: const EdgeInsets.all(2),
                  decoration: BoxDecoration(
                    color: AppColors.surfaceElevated,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _buildModeButton(
                        icon: Icons.gamepad_rounded,
                        label: 'Game',
                        isActive: _showArcadeGame,
                        onTap: () => setState(() => _showArcadeGame = true),
                      ),
                      _buildModeButton(
                        icon: Icons.radar_rounded,
                        label: 'Radar',
                        isActive: !_showArcadeGame,
                        onTap: () => setState(() => _showArcadeGame = false),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),

          const Divider(height: 1, color: AppColors.border),

          // ─── ACTIVE VIEW (GAME OR RADAR) ─────────────────────────
          Padding(
            padding: const EdgeInsets.all(14),
            child: _showArcadeGame
                ? _QueueRunnerGame(
                    tokenCode: widget.tokenCode,
                    waitMinutes: widget.waitMinutes,
                    position: widget.position,
                    peopleAhead: widget.peopleAhead,
                  )
                : _QueueRadarView(
                    tokenCode: widget.tokenCode,
                    position: widget.position,
                    peopleAhead: widget.peopleAhead,
                    servingToken: widget.servingToken,
                    counterName: widget.counterName,
                    waitMinutes: widget.waitMinutes,
                    status: widget.status,
                    isDemo: widget.isDemo,
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildModeButton({
    required IconData icon,
    required String label,
    required bool isActive,
    required VoidCallback onTap,
  }) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: isActive ? AppColors.primary : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              icon,
              size: 13,
              color: isActive ? Colors.black : AppColors.textMuted,
            ),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: isActive ? FontWeight.bold : FontWeight.w500,
                color: isActive ? Colors.black : AppColors.textMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎮 QUEUE RUNNER MINI-GAME IMPLEMENTATION
// ─────────────────────────────────────────────────────────────────────────────

class _QueueRunnerGame extends StatefulWidget {
  const _QueueRunnerGame({
    required this.tokenCode,
    required this.waitMinutes,
    required this.position,
    required this.peopleAhead,
  });

  final String tokenCode;
  final int waitMinutes;
  final int position;
  final int peopleAhead;

  @override
  State<_QueueRunnerGame> createState() => _QueueRunnerGameState();
}

class _QueueRunnerGameState extends State<_QueueRunnerGame> {
  Timer? _gameLoop;
  bool _isPlaying = false;
  bool _isGameOver = false;

  int _score = 0;
  int _highScore = 0;

  // Player physics
  double _playerY = 0; // 0 is ground, positive is in air
  double _velocityY = 0;
  int _jumpCount = 0;
  static const double _gravity = 0.58;
  static const double _jumpStrength = 10.8;

  // Obstacles & Collectibles
  final List<_GameEntity> _obstacles = [];
  final List<_GameEntity> _collectibles = [];
  final List<_Particle> _particles = [];

  int _ticksSinceLastObstacle = 0;
  int _ticksSinceLastCollectible = 0;
  final math.Random _random = math.Random();

  @override
  void dispose() {
    _gameLoop?.cancel();
    super.dispose();
  }

  void _startGame() {
    _gameLoop?.cancel();
    setState(() {
      _isPlaying = true;
      _isGameOver = false;
      _score = 0;
      _playerY = 0;
      _velocityY = 0;
      _jumpCount = 0;
      _obstacles.clear();
      _collectibles.clear();
      _particles.clear();
      _ticksSinceLastObstacle = 0;
      _ticksSinceLastCollectible = 0;
    });

    _gameLoop = Timer.periodic(const Duration(milliseconds: 20), (timer) {
      _updateGame();
    });
  }

  void _jump() {
    if (!_isPlaying) {
      _startGame();
      return;
    }
    if (_isGameOver) {
      _startGame();
      return;
    }

    // Allow double jump
    if (_jumpCount < 2) {
      setState(() {
        _velocityY = _jumpStrength;
        _jumpCount++;
      });
    }
  }

  void _updateGame() {
    if (!_isPlaying || _isGameOver) return;

    setState(() {
      // 1. Update Player Physics
      _playerY += _velocityY;
      _velocityY -= _gravity;

      if (_playerY <= 0) {
        _playerY = 0;
        _velocityY = 0;
        _jumpCount = 0;
      }

      // Base speed increases with score
      final speed = 3.6 + (_score / 350).clamp(0.0, 3.5);

      // 2. Score progression
      _score += 1;
      if (_score > _highScore) {
        _highScore = _score;
      }

      // 3. Spawn Obstacles
      _ticksSinceLastObstacle++;
      final obstacleInterval = math.max(65, 110 - (_score ~/ 20));
      if (_ticksSinceLastObstacle >= obstacleInterval && _random.nextDouble() > 0.3) {
        _ticksSinceLastObstacle = 0;
        final type = _random.nextBool() ? _EntityType.barrier : _EntityType.cone;
        _obstacles.add(_GameEntity(
          x: 320,
          y: 0,
          width: 22,
          height: type == _EntityType.barrier ? 34 : 26,
          type: type,
        ));
      }

      // 4. Spawn Collectibles (Flow Stars)
      _ticksSinceLastCollectible++;
      if (_ticksSinceLastCollectible >= 130 && _random.nextDouble() > 0.4) {
        _ticksSinceLastCollectible = 0;
        _collectibles.add(_GameEntity(
          x: 320,
          y: 35 + _random.nextDouble() * 40,
          width: 20,
          height: 20,
          type: _EntityType.star,
        ));
      }

      // 5. Update & check Obstacles
      final playerRect = Rect.fromLTWH(36, 130 - _playerY - 28, 24, 28);

      for (int i = _obstacles.length - 1; i >= 0; i--) {
        final obs = _obstacles[i];
        obs.x -= speed;

        final obsRect = Rect.fromLTWH(obs.x, 130 - obs.height, obs.width, obs.height);
        // Collision check
        if (playerRect.overlaps(obsRect)) {
          _gameOver();
          return;
        }

        if (obs.x < -40) {
          _obstacles.removeAt(i);
        }
      }

      // 6. Update & check Collectibles
      for (int i = _collectibles.length - 1; i >= 0; i--) {
        final item = _collectibles[i];
        item.x -= speed;

        final itemRect = Rect.fromLTWH(item.x, 130 - item.y - item.height, item.width, item.height);
        if (playerRect.overlaps(itemRect)) {
          _score += 40;
          _spawnParticles(item.x + 10, 130 - item.y - 10);
          _collectibles.removeAt(i);
          continue;
        }

        if (item.x < -30) {
          _collectibles.removeAt(i);
        }
      }

      // 7. Update Particles
      for (int i = _particles.length - 1; i >= 0; i--) {
        final p = _particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.05;
        if (p.life <= 0) {
          _particles.removeAt(i);
        }
      }
    });
  }

  void _spawnParticles(double x, double y) {
    for (int i = 0; i < 8; i++) {
      final angle = _random.nextDouble() * 2 * math.pi;
      final pSpeed = 1.5 + _random.nextDouble() * 2.5;
      _particles.add(_Particle(
        x: x,
        y: y,
        vx: math.cos(angle) * pSpeed,
        vy: math.sin(angle) * pSpeed,
        color: i.isEven ? AppColors.secondary : AppColors.primary,
      ));
    }
  }

  void _gameOver() {
    _gameLoop?.cancel();
    setState(() {
      _isGameOver = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // ─── WAITING QUEUE HUD BANNER ──────────────────────────────
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: AppColors.surfaceElevated,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  const Icon(Icons.access_time_rounded, size: 14, color: AppColors.warning),
                  const SizedBox(width: 6),
                  Text(
                    'Position #${widget.position} • Est. ${widget.waitMinutes}m wait',
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ],
              ),
              Row(
                children: [
                  Text(
                    'Score: ',
                    style: AppTheme.monoStyle(fontSize: 11, color: AppColors.textSecondary),
                  ),
                  Text(
                    '$_score',
                    style: AppTheme.monoStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                      color: AppColors.primary,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Text(
                    'Best: $_highScore',
                    style: AppTheme.monoStyle(fontSize: 11, color: AppColors.secondary),
                  ),
                ],
              ),
            ],
          ),
        ),

        const SizedBox(height: 10),

        // ─── PLAYABLE GAME CANVAS ─────────────────────────────────
        GestureDetector(
          onTapDown: (_) => _jump(),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Container(
              height: 170,
              width: double.infinity,
              decoration: BoxDecoration(
                color: AppColors.background,
                border: Border.all(color: AppColors.border),
              ),
              child: Stack(
                children: [
                  // Animated Canvas Rendering
                  CustomPaint(
                    size: const Size(double.infinity, 170),
                    painter: _GameCanvasPainter(
                      playerY: _playerY,
                      obstacles: _obstacles,
                      collectibles: _collectibles,
                      particles: _particles,
                      jumpCount: _jumpCount,
                      tokenCode: widget.tokenCode,
                    ),
                  ),

                  // Start Overlay (when not playing yet)
                  if (!_isPlaying && !_isGameOver)
                    Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                        decoration: BoxDecoration(
                          color: AppColors.surface.withValues(alpha: 0.92),
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: AppColors.primary, width: 1.5),
                          boxShadow: [
                            BoxShadow(
                              color: AppColors.primary.withValues(alpha: 0.2),
                              blurRadius: 16,
                            ),
                          ],
                        ),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.play_circle_fill_rounded, color: AppColors.primary, size: 36),
                            const SizedBox(height: 8),
                            const Text(
                              'QUEUE JUMPER ARCADE',
                              style: TextStyle(
                                fontWeight: FontWeight.w900,
                                fontSize: 14,
                                letterSpacing: 1,
                                color: AppColors.textPrimary,
                              ),
                            ),
                            const SizedBox(height: 4),
                            const Text(
                              'Tap anywhere to Jump & Double-Jump!\nDodge queue barriers and catch bonus passes.',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: AppColors.textSecondary, fontSize: 11),
                            ),
                            const SizedBox(height: 12),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                              decoration: BoxDecoration(
                                color: AppColors.primary,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: const Text(
                                'TAP TO START',
                                style: TextStyle(
                                  color: Colors.black,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),

                  // Game Over Overlay
                  if (_isGameOver)
                    Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
                        decoration: BoxDecoration(
                          color: AppColors.surface.withValues(alpha: 0.95),
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: AppColors.danger, width: 1.5),
                          boxShadow: [
                            BoxShadow(
                              color: AppColors.danger.withValues(alpha: 0.2),
                              blurRadius: 16,
                            ),
                          ],
                        ),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Text(
                              'GAME OVER',
                              style: TextStyle(
                                fontWeight: FontWeight.w900,
                                fontSize: 16,
                                color: AppColors.danger,
                                letterSpacing: 1,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Score: $_score  •  Best: $_highScore',
                              style: AppTheme.monoStyle(fontSize: 12, color: AppColors.textPrimary),
                            ),
                            const SizedBox(height: 10),
                            ElevatedButton.icon(
                              onPressed: _startGame,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: AppColors.primary,
                                foregroundColor: Colors.black,
                                visualDensity: VisualDensity.compact,
                              ),
                              icon: const Icon(Icons.replay_rounded, size: 16),
                              label: const Text('Play Again'),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),

        const SizedBox(height: 10),

        // ─── ACTION BUTTON & TIPS ──────────────────────────────────
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              children: [
                const Icon(Icons.touch_app_rounded, size: 14, color: AppColors.textMuted),
                const SizedBox(width: 4),
                Text(
                  _isPlaying ? 'Tap to Jump (2x Double Jump)' : 'Tap canvas to play',
                  style: const TextStyle(fontSize: 11, color: AppColors.textSecondary),
                ),
              ],
            ),
            if (_isPlaying && !_isGameOver)
              GestureDetector(
                onTap: _jump,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: AppColors.primary),
                  ),
                  child: const Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.arrow_upward_rounded, size: 14, color: AppColors.primary),
                      SizedBox(width: 4),
                      Text(
                        'JUMP!',
                        style: TextStyle(
                          color: AppColors.primary,
                          fontWeight: FontWeight.bold,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }
}

enum _EntityType { barrier, cone, star }

class _GameEntity {
  _GameEntity({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required this.type,
  });

  double x;
  double y;
  final double width;
  final double height;
  final _EntityType type;
}

class _Particle {
  _Particle({
    required this.x,
    required this.y,
    required this.vx,
    required this.vy,
    required this.color,
  });

  double x;
  double y;
  final double vx;
  final double vy;
  final Color color;
  double life = 1.0;
}

class _GameCanvasPainter extends CustomPainter {
  _GameCanvasPainter({
    required this.playerY,
    required this.obstacles,
    required this.collectibles,
    required this.particles,
    required this.jumpCount,
    required this.tokenCode,
  });

  final double playerY;
  final List<_GameEntity> obstacles;
  final List<_GameEntity> collectibles;
  final List<_Particle> particles;
  final int jumpCount;
  final String tokenCode;

  @override
  void paint(Canvas canvas, Size size) {
    const groundY = 135.0;

    // 1. Background Grid / Cyber lines
    final gridPaint = Paint()
      ..color = AppColors.border.withValues(alpha: 0.3)
      ..strokeWidth = 1.0;

    for (double x = 0; x < size.width; x += 30) {
      canvas.drawLine(Offset(x, 0), Offset(x, groundY), gridPaint);
    }

    // 2. Ground Line (Neon Runway)
    final groundPaint = Paint()
      ..color = AppColors.primary.withValues(alpha: 0.8)
      ..strokeWidth = 2.5;

    canvas.drawLine(const Offset(0, groundY), Offset(size.width, groundY), groundPaint);

    final groundGlow = Paint()
      ..color = AppColors.primary.withValues(alpha: 0.15)
      ..strokeWidth = 8.0;
    canvas.drawLine(const Offset(0, groundY + 3), Offset(size.width, groundY + 3), groundGlow);

    // 3. Draw Obstacles
    for (final obs in obstacles) {
      final rect = Rect.fromLTWH(obs.x, groundY - obs.height, obs.width, obs.height);

      if (obs.type == _EntityType.barrier) {
        // Red tape barrier
        final barrierPaint = Paint()..color = AppColors.danger;
        canvas.drawRRect(RRect.fromRectAndRadius(rect, const Radius.circular(4)), barrierPaint);

        // Stripes
        final stripePaint = Paint()..color = Colors.white.withValues(alpha: 0.6);
        canvas.drawLine(
          Offset(obs.x, groundY - obs.height + 6),
          Offset(obs.x + obs.width, groundY - obs.height + 6),
          stripePaint,
        );
      } else {
        // Traffic Cone
        final conePath = Path()
          ..moveTo(obs.x + obs.width / 2, groundY - obs.height)
          ..lineTo(obs.x + obs.width, groundY)
          ..lineTo(obs.x, groundY)
          ..close();

        final conePaint = Paint()..color = AppColors.warning;
        canvas.drawPath(conePath, conePaint);
      }
    }

    // 4. Draw Collectibles (Flow Stars / Bonus Tickets)
    for (final item in collectibles) {
      final itemCenter = Offset(item.x + item.width / 2, groundY - item.y - item.height / 2);

      final starGlow = Paint()
        ..color = AppColors.secondary.withValues(alpha: 0.3)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6);
      canvas.drawCircle(itemCenter, 10, starGlow);

      final starPaint = Paint()..color = AppColors.secondary;
      canvas.drawCircle(itemCenter, 7, starPaint);

      final innerStar = Paint()..color = Colors.white;
      canvas.drawCircle(itemCenter, 3.5, innerStar);
    }

    // 5. Draw Particles
    for (final p in particles) {
      final pPaint = Paint()
        ..color = p.color.withValues(alpha: p.life)
        ..strokeWidth = 2.0;
      canvas.drawCircle(Offset(p.x, p.y), 2.5 * p.life, pPaint);
    }

    // 6. Draw Player (Queue Runner Token Avatar)
    final playerCenter = Offset(48, groundY - playerY - 14);

    // Jet / Jump Trail
    if (playerY > 5) {
      final trailPaint = Paint()
        ..color = (jumpCount > 1 ? AppColors.secondary : AppColors.primary).withValues(alpha: 0.5)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 4);
      canvas.drawCircle(Offset(playerCenter.dx, groundY - playerY + 4), 6, trailPaint);
    }

    // Outer Glow Ring
    final glowPaint = Paint()
      ..color = AppColors.primary.withValues(alpha: 0.3)
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 8);
    canvas.drawCircle(playerCenter, 16, glowPaint);

    // Avatar Body (Glowing Token Disc)
    final playerPaint = Paint()..color = AppColors.surfaceElevated;
    canvas.drawCircle(playerCenter, 13, playerPaint);

    final playerBorder = Paint()
      ..color = AppColors.primary
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.0;
    canvas.drawCircle(playerCenter, 13, playerBorder);

    // Inner icon / star
    final innerPaint = Paint()..color = AppColors.primary;
    canvas.drawCircle(playerCenter, 5, innerPaint);
  }

  @override
  bool shouldRepaint(covariant _GameCanvasPainter oldDelegate) => true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 📡 QUEUE RADAR VIEW (Secondary view available via toggle)
// ─────────────────────────────────────────────────────────────────────────────

class _QueueRadarView extends StatelessWidget {
  const _QueueRadarView({
    required this.tokenCode,
    required this.position,
    required this.peopleAhead,
    required this.servingToken,
    required this.counterName,
    required this.waitMinutes,
    required this.status,
    required this.isDemo,
  });

  final String tokenCode;
  final int position;
  final int peopleAhead;
  final String servingToken;
  final String counterName;
  final int waitMinutes;
  final String status;
  final bool isDemo;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'LIVE LINE OVERVIEW',
                style: AppTheme.monoStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.bold,
                  color: AppColors.secondary,
                ),
              ),
              Text(
                'Serving: $servingToken',
                style: AppTheme.monoStyle(fontSize: 11, color: AppColors.textSecondary),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _buildRadarNode(
                icon: Icons.storefront_rounded,
                title: counterName,
                subtitle: 'Front',
                color: AppColors.secondary,
              ),
              const Icon(Icons.arrow_forward_rounded, size: 14, color: AppColors.borderLight),
              _buildRadarNode(
                icon: Icons.people_outline_rounded,
                title: '$peopleAhead Ahead',
                subtitle: '~${waitMinutes}m wait',
                color: AppColors.warning,
              ),
              const Icon(Icons.arrow_forward_rounded, size: 14, color: AppColors.borderLight),
              _buildRadarNode(
                icon: Icons.person_pin_circle_rounded,
                title: 'You ($tokenCode)',
                subtitle: 'Pos #$position',
                color: AppColors.primary,
                isUser: true,
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildRadarNode({
    required IconData icon,
    required String title,
    required String subtitle,
    required Color color,
    bool isUser = false,
  }) {
    return Column(
      children: [
        Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.18),
            shape: BoxShape.circle,
            border: Border.all(color: color, width: isUser ? 2 : 1),
          ),
          child: Icon(icon, color: color, size: 18),
        ),
        const SizedBox(height: 6),
        Text(
          title,
          style: TextStyle(
            fontSize: 11,
            fontWeight: isUser ? FontWeight.bold : FontWeight.w600,
            color: isUser ? color : AppColors.textPrimary,
          ),
        ),
        Text(
          subtitle,
          style: AppTheme.monoStyle(fontSize: 9, color: AppColors.textMuted),
        ),
      ],
    );
  }
}
