"""Disposable backend for MCP checks; never starts bots, schedulers or Redis."""
import asyncio
import contextlib
import json
import os
import socket
from datetime import date
from pathlib import Path

import uvicorn

from app.core.config import settings
from app.core.database import database
from app.main import Application
from app.models import Bot, CaseMember, Dialog, Message, User
from app.schemas.case import CaseCreate
from app.services.api_token import ApiTokenService
from app.services.case import CaseService


async def main():
    assert settings.postgres_db == "operbots_mcp_qa", "Use a disposable operbots_mcp_qa database"
    assert settings.postgres_host == "127.0.0.1", "QA database must be local"
    assert os.environ.get("OPERBOTS_QA_DISABLE_REDIS") == "1", "Explicitly disable Redis for QA"
    settings.redis_url = ""
    fixture = Path(os.environ["OPERBOTS_QA_FIXTURE"])
    assert not fixture.exists(), "Do not overwrite an existing fixture"
    database.connect()
    try:
        async with database.transaction() as session:
            owner = User(email="mcp-owner@example.com", password_hash="qa-only",
                         first_name="Owner", last_name="QA", birth_date=date(1990, 1, 1), profile_completed=True)
            viewer = User(email="mcp-viewer@example.com", password_hash="qa-only",
                          first_name="Viewer", last_name="QA", birth_date=date(1990, 1, 1), profile_completed=True)
            session.add_all([owner, viewer])
            await session.flush()
            case = await CaseService(session).create(owner, CaseCreate(name="MCP QA"))
            other = await CaseService(session).create(owner, CaseCreate(name="Other QA"))
            session.add(CaseMember(case_id=case.id, user_id=viewer.id,
                                   extra_permissions=["case.view", "request.view"]))
            bot = Bot(case_id=case.id, name="Fixture bot", token_encrypted="qa-only",
                      autostart=False, is_enabled=False)
            session.add(bot)
            await session.flush()
            dialog = Dialog(bot_id=bot.id, chat_id=42, first_name="Contact", unread_count=2)
            session.add(dialog)
            await session.flush()
            message = Message(dialog_id=dialog.id, direction="incoming", author="contact", text="Need help")
            session.add(message)
            await session.flush()
            _, owner_token = await ApiTokenService(session).issue(owner, "MCP QA owner")
            _, viewer_token = await ApiTokenService(session).issue(viewer, "MCP QA viewer")
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        values = {"database": settings.postgres_db, "url": f"http://127.0.0.1:{sock.getsockname()[1]}",
                  "owner_token": owner_token, "viewer_token": viewer_token,
                  "case_id": str(case.id), "other_case_id": str(other.id), "owner_id": str(owner.id),
                  "bot_id": str(bot.id), "dialog_id": str(dialog.id), "message_id": str(message.id)}
        fixture.write_text(json.dumps(values), encoding="utf-8")
        server = uvicorn.Server(uvicorn.Config(Application().create(), lifespan="off", log_level="warning"))

        async def stop_after_check():
            while fixture.exists():
                await asyncio.sleep(0.5)
            server.should_exit = True

        watcher = asyncio.create_task(stop_after_check())
        try:
            await server.serve(sockets=[sock])
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
            sock.close()
    finally:
        await database.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
