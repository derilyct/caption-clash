/**
 * Caption Clash - Client Application
 */
(function () {
  'use strict';

  const socket = io();

  // --- State ---
  let myId = null;
  let myPlayer = null;
  let roomCode = null;
  let isHost = false;
  let hasSubmittedCaption = false;
  let hasVoted = false;
  let currentCaptions = [];

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const screens = {
    landing: $('#screen-landing'),
    lobby: $('#screen-lobby'),
    captioning: $('#screen-captioning'),
    voting: $('#screen-voting'),
    results: $('#screen-results'),
    gameover: $('#screen-gameover'),
  };

  // Landing
  const inputUsername = $('#input-username');
  const inputRoomCode = $('#input-room-code');
  const btnCreate = $('#btn-create');
  const btnJoin = $('#btn-join');
  const landingError = $('#landing-error');

  // Lobby
  const lobbyRoomCode = $('#lobby-room-code');
  const lobbyPlayers = $('#lobby-players');
  const btnStart = $('#btn-start');
  const lobbyWaiting = $('#lobby-waiting');

  // Captioning
  const captionRound = $('#caption-round');
  const captionTimer = $('#caption-timer');
  const captionImage = $('#caption-image');
  const inputCaption = $('#input-caption');
  const charCount = $('#char-count');
  const btnSubmitCaption = $('#btn-submit-caption');
  const captionCount = $('#caption-count');
  const captionTotal = $('#caption-total');
  const captionSubmittedMsg = $('#caption-submitted-msg');

  // Voting
  const voteTimer = $('#vote-timer');
  const voteImage = $('#vote-image');
  const voteCaptions = $('#vote-captions');
  const voteCount = $('#vote-count');
  const voteTotal = $('#vote-total');
  const voteSubmittedMsg = $('#vote-submitted-msg');

  // Results
  const resultsImage = $('#results-image');
  const resultsWinner = $('#results-winner');
  const resultsCaptions = $('#results-captions');
  const resultsScoreboard = $('#results-scoreboard');
  const btnNextRound = $('#btn-next-round');
  const resultsWaiting = $('#results-waiting');

  // Game Over
  const gameoverWinner = $('#gameover-winner');
  const gameoverScoreboard = $('#gameover-scoreboard');
  const btnPlayAgain = $('#btn-play-again');
  const btnNewGame = $('#btn-new-game');

  // --- Screen management ---
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  // --- Utilities ---
  function renderPlayerCard(player) {
    return `
      <div class="player-card ${player.isHost ? 'is-host' : ''}">
        ${player.isHost ? '<span class="host-badge">Host</span>' : ''}
        <div class="player-avatar" style="background:${player.avatar.color}">
          ${player.avatar.emoji}
        </div>
        <div class="player-name">${escapeHtml(player.username)}</div>
        <div class="player-stats">
          ${player.gamesWon} game${player.gamesWon !== 1 ? 's' : ''} won
          &middot; ${player.captionsWon} caption${player.captionsWon !== 1 ? 's' : ''}
        </div>
      </div>
    `;
  }

  function renderScoreboard(board) {
    return board
      .map(
        (p, i) => `
        <div class="score-row">
          <span class="score-rank">#${i + 1}</span>
          <div class="score-avatar" style="background:${p.avatar.color}">${p.avatar.emoji}</div>
          <span class="score-name">${escapeHtml(p.username)}</span>
          <span class="score-games">${p.gamesWon}W</span>
          <span class="score-value">${p.score}</span>
        </div>
      `
      )
      .join('');
  }

  function updateTimer(el, seconds) {
    el.textContent = seconds;
    el.classList.remove('warning', 'danger');
    if (seconds <= 10) el.classList.add('danger');
    else if (seconds <= 30) el.classList.add('warning');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Event: Create room ---
  btnCreate.addEventListener('click', () => {
    const username = inputUsername.value.trim();
    if (!username) {
      landingError.textContent = 'Please enter a nickname';
      return;
    }
    btnCreate.disabled = true;
    socket.emit('create-room', { username }, (res) => {
      btnCreate.disabled = false;
      if (!res.success) {
        landingError.textContent = res.error;
        return;
      }
      myId = socket.id;
      myPlayer = res.player;
      roomCode = res.roomCode;
      isHost = true;
      enterLobby(res.roomCode, res.players);
    });
  });

  // --- Event: Join room ---
  btnJoin.addEventListener('click', () => {
    const username = inputUsername.value.trim();
    const code = inputRoomCode.value.trim().toUpperCase();
    if (!username) {
      landingError.textContent = 'Please enter a nickname';
      return;
    }
    if (!code || code.length !== 4) {
      landingError.textContent = 'Enter a 4-character room code';
      return;
    }
    btnJoin.disabled = true;
    socket.emit('join-room', { username, roomCode: code }, (res) => {
      btnJoin.disabled = false;
      if (!res.success) {
        landingError.textContent = res.error;
        return;
      }
      myId = socket.id;
      myPlayer = res.player;
      roomCode = res.roomCode;
      isHost = false;
      enterLobby(res.roomCode, res.players);
    });
  });

  // Allow Enter key on inputs
  inputUsername.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnCreate.click();
  });
  inputRoomCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });

  // --- Lobby ---
  function enterLobby(code, players) {
    landingError.textContent = '';
    lobbyRoomCode.textContent = code;
    renderLobbyPlayers(players);
    updateHostControls(players);
    showScreen('lobby');
  }

  function renderLobbyPlayers(players) {
    lobbyPlayers.innerHTML = players.map(renderPlayerCard).join('');
  }

  function updateHostControls(players) {
    // Determine if we're host
    const me = players.find((p) => p.id === myId);
    if (me) isHost = me.isHost;

    if (isHost) {
      btnStart.style.display = 'inline-block';
      btnStart.disabled = players.length < 2;
      lobbyWaiting.style.display = 'none';
    } else {
      btnStart.style.display = 'none';
      lobbyWaiting.style.display = 'block';
    }
  }

  // Start game button
  btnStart.addEventListener('click', () => {
    btnStart.disabled = true;
    socket.emit('start-game', null, (res) => {
      if (!res.success) {
        btnStart.disabled = false;
        alert(res.error);
      }
    });
  });

  // --- Socket events: Lobby ---
  socket.on('player-joined', (data) => {
    renderLobbyPlayers(data.players);
    updateHostControls(data.players);
  });

  socket.on('player-left', (data) => {
    if (data.newHostId === myId) isHost = true;
    renderLobbyPlayers(data.players);
    updateHostControls(data.players);
  });

  // --- Socket events: Captioning ---
  socket.on('round-start', (data) => {
    hasSubmittedCaption = false;
    captionSubmittedMsg.style.display = 'none';
    inputCaption.value = '';
    inputCaption.disabled = false;
    btnSubmitCaption.disabled = false;
    charCount.textContent = '0';

    captionRound.textContent = data.roundNumber;
    captionImage.src = data.image.url;
    updateTimer(captionTimer, data.timeRemaining);
    captionCount.textContent = '0';
    captionTotal.textContent = '0';

    showScreen('captioning');
  });

  // Character counter
  inputCaption.addEventListener('input', () => {
    const len = inputCaption.value.length;
    charCount.textContent = len;
    const countEl = charCount.parentElement;
    countEl.classList.remove('near-limit', 'at-limit');
    if (len >= 100) countEl.classList.add('at-limit');
    else if (len >= 80) countEl.classList.add('near-limit');
  });

  // Submit caption
  btnSubmitCaption.addEventListener('click', () => {
    const caption = inputCaption.value.trim();
    if (!caption) return;

    btnSubmitCaption.disabled = true;
    socket.emit('submit-caption', { caption }, (res) => {
      if (!res.success) {
        btnSubmitCaption.disabled = false;
        alert(res.error);
        return;
      }
      hasSubmittedCaption = true;
      inputCaption.disabled = true;
      captionSubmittedMsg.style.display = 'flex';
    });
  });

  // Allow Ctrl+Enter to submit caption
  inputCaption.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      btnSubmitCaption.click();
    }
  });

  socket.on('caption-submitted', (data) => {
    captionCount.textContent = data.totalSubmitted;
    captionTotal.textContent = data.totalPlayers;
  });

  // --- Socket events: Voting ---
  socket.on('voting-start', (data) => {
    hasVoted = false;
    voteSubmittedMsg.style.display = 'none';
    currentCaptions = data.captions;

    voteImage.src = data.image.url;
    updateTimer(voteTimer, data.timeRemaining);
    voteCount.textContent = '0';
    voteTotal.textContent = '0';

    renderVoteCaptions(data.captions);
    showScreen('voting');
  });

  function renderVoteCaptions(captions) {
    voteCaptions.innerHTML = captions
      .map((c) => {
        const isOwn = c.id === myId;
        return `
          <div class="vote-caption-card ${isOwn ? 'own-caption' : ''}"
               data-author-id="${c.id}">
            ${escapeHtml(c.text)}
          </div>
        `;
      })
      .join('');

    // Attach click handlers
    voteCaptions.querySelectorAll('.vote-caption-card').forEach((card) => {
      card.addEventListener('click', () => {
        if (hasVoted) return;
        if (card.classList.contains('own-caption')) return;

        // Highlight selection
        voteCaptions
          .querySelectorAll('.vote-caption-card')
          .forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');

        // Submit vote
        const authorId = card.dataset.authorId;
        hasVoted = true;

        socket.emit('submit-vote', { captionAuthorId: authorId }, (res) => {
          if (!res.success) {
            hasVoted = false;
            card.classList.remove('selected');
            alert(res.error);
            return;
          }
          voteSubmittedMsg.style.display = 'flex';
        });
      });
    });
  }

  socket.on('vote-submitted', (data) => {
    voteCount.textContent = data.totalVoted;
    voteTotal.textContent = data.totalVoters;
  });

  // --- Socket events: Timer ---
  socket.on('timer-tick', (data) => {
    if (data.phase === 'captioning') {
      updateTimer(captionTimer, data.timeRemaining);
    } else if (data.phase === 'voting') {
      updateTimer(voteTimer, data.timeRemaining);
    }
  });

  // --- Socket events: Results ---
  socket.on('round-results', (data) => {
    // Image
    resultsImage.src = data.image.url;

    // Winner banner
    if (data.winners.length > 0) {
      const w = data.winners[0];
      resultsWinner.innerHTML = `
        <div class="winner-label">Winning Caption</div>
        <div class="winner-caption">"${escapeHtml(w.caption)}"</div>
        <div class="winner-author">— ${escapeHtml(w.username)}</div>
      `;
      resultsWinner.style.display = 'block';
    } else {
      resultsWinner.innerHTML = `
        <div class="winner-label">No Votes</div>
        <div class="winner-caption">Nobody voted this round!</div>
      `;
      resultsWinner.style.display = 'block';
    }

    // All captions with votes
    resultsCaptions.innerHTML = data.results
      .map(
        (r) => `
        <div class="result-caption-row ${r.isWinner ? 'is-winner' : ''}">
          <div class="result-avatar" style="background:${r.avatar?.color || '#333'}">
            ${r.avatar?.emoji || '?'}
          </div>
          <div class="result-text">
            <div>"${escapeHtml(r.caption)}"</div>
            <div class="result-author">${escapeHtml(r.username)}</div>
          </div>
          <div class="result-votes">${r.votes} vote${r.votes !== 1 ? 's' : ''}</div>
        </div>
      `
      )
      .join('');

    // Scoreboard
    resultsScoreboard.innerHTML = renderScoreboard(data.scoreboard);

    // Game over or next round?
    if (data.state === 'gameover') {
      showGameOver(data.gameWinner, data.scoreboard);
    } else {
      // Show next round controls
      if (isHost) {
        btnNextRound.style.display = 'inline-block';
        btnNextRound.disabled = false;
        resultsWaiting.style.display = 'none';
      } else {
        btnNextRound.style.display = 'none';
        resultsWaiting.style.display = 'block';
      }
      showScreen('results');
    }
  });

  // Next round
  btnNextRound.addEventListener('click', () => {
    btnNextRound.disabled = true;
    socket.emit('next-round', null, (res) => {
      if (!res.success) {
        btnNextRound.disabled = false;
        alert(res.error);
      }
    });
  });

  // Round skipped (not enough captions)
  socket.on('round-skipped', (data) => {
    resultsWinner.innerHTML = `
      <div class="winner-label">Round Skipped</div>
      <div class="winner-caption">${escapeHtml(data.reason)}</div>
    `;
    resultsWinner.style.display = 'block';
    resultsCaptions.innerHTML = '';
    resultsImage.src = '';
    resultsScoreboard.innerHTML = renderScoreboard(data.scoreboard);

    if (isHost) {
      btnNextRound.style.display = 'inline-block';
      btnNextRound.disabled = false;
      resultsWaiting.style.display = 'none';
    } else {
      btnNextRound.style.display = 'none';
      resultsWaiting.style.display = 'block';
    }
    showScreen('results');
  });

  // --- Game Over ---
  function showGameOver(winner, scoreboard) {
    gameoverWinner.innerHTML = `
      <div class="gw-avatar" style="background:${winner.avatar.color}; border-color:${winner.avatar.color}">
        ${winner.avatar.emoji}
      </div>
      <div class="gw-name">${escapeHtml(winner.username)}</div>
      <div class="gw-label">Champion &middot; ${winner.score} Captions Won</div>
    `;

    gameoverScoreboard.innerHTML = renderScoreboard(scoreboard);

    if (isHost) {
      btnPlayAgain.style.display = 'inline-block';
    } else {
      btnPlayAgain.style.display = 'none';
    }

    showScreen('gameover');
  }

  // Play again
  btnPlayAgain.addEventListener('click', () => {
    btnPlayAgain.disabled = true;
    socket.emit('play-again', null, (res) => {
      btnPlayAgain.disabled = false;
      if (!res.success) {
        alert(res.error);
      }
    });
  });

  socket.on('game-reset', (data) => {
    renderLobbyPlayers(data.players);
    updateHostControls(data.players);
    showScreen('lobby');
  });

  // New game (leave current)
  btnNewGame.addEventListener('click', () => {
    socket.emit('leave-game');
    resetClientState();
    showScreen('landing');
  });

  function resetClientState() {
    myId = null;
    myPlayer = null;
    roomCode = null;
    isHost = false;
    hasSubmittedCaption = false;
    hasVoted = false;
    currentCaptions = [];
    inputUsername.value = '';
    inputRoomCode.value = '';
    landingError.textContent = '';
  }

  // Handle disconnect
  socket.on('disconnect', () => {
    resetClientState();
    showScreen('landing');
    landingError.textContent = 'Disconnected from server';
  });

  socket.on('connect', () => {
    // If reconnecting, we've lost state, go to landing
    if (myId && myId !== socket.id) {
      resetClientState();
      showScreen('landing');
    }
    myId = socket.id;
  });
})();
